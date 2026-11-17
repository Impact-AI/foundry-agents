import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { type AgentDefinitionUnion, AIProjectClient } from "@azure/ai-projects";
import {
	createHttpHeaders,
	type HttpClient,
	type PipelinePolicy,
	type PipelineRequest,
} from "@azure/core-rest-pipeline";
import {
	azureCredential,
	createEntraTokenProvider,
	envInt,
	envString,
	processSingleton,
	resetSingleton,
} from "@platform/config";
import {
	cachedLlmSettings,
	llmSettings,
	providerFetch,
	roleLimiter,
} from "@platform/llm";
import OpenAI from "openai";

/**
 * The Agent Service, dialled one way, and the only file that imports its
 * SDKs: `@azure/ai-projects` for the project's own operations (agents and
 * their versions, skills) and the `openai` client for the
 * OpenAI-compatible surface the project serves at `/openai/v1`
 * (conversations, their items, responses). Both present the backend's
 * managed identity, keyless, and both send every request through
 * `@platform/llm`'s one provider fetch: the seam a test stands the service in
 * at, with the SDKs above it running for real.
 *
 * The OpenAI client is built here rather than taken from
 * `AIProjectClient.getOpenAIClient()`, which in 2.10.0 replaces any `fetch`
 * it is given with the global one.
 */

/** The audience the project's data plane accepts. */
const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

/**
 * How long one request may take: its whole answer, or a streamed
 * response's headers (the stream itself runs as long as the model writes,
 * held to {@link STREAM_IDLE_MS} between its events).
 * Neither SDK bounds the project's calls by default, and the project is on
 * every turn's path, so a service that stops answering would hold every
 * turn with it.
 */
function requestDeadlineMs(): number {
	return envInt("FOUNDRY_REQUEST_DEADLINE_MS", 30_000, { min: 1 });
}

class FoundryNotConfigured extends Error {
	constructor() {
		super(
			"No Foundry project is configured: set FOUNDRY_PROJECT_ENDPOINT to the project's endpoint.",
		);
		this.name = "FoundryNotConfigured";
	}
}

function foundryEndpoint(): string {
	const endpoint = envString("FOUNDRY_PROJECT_ENDPOINT");
	if (!endpoint) throw new FoundryNotConfigured();
	return endpoint.replace(/\/+$/, "");
}

/**
 * The pipeline's transport, over the provider fetch: the project client's
 * policies — the bearer token, retries that honour `Retry-After` — run as
 * the SDK has them, and only the last hop is this package's.
 */
function providerHttpClient(): HttpClient {
	const deadlineMs = requestDeadlineMs();
	return {
		async sendRequest(request: PipelineRequest) {
			if (request.body !== undefined && typeof request.body !== "string")
				throw new Error("only a JSON body is sent to the project");
			const deadline = AbortSignal.timeout(deadlineMs);
			const res = await providerFetch()(request.url, {
				method: request.method,
				headers: request.headers.toJSON(),
				body: request.body,
				signal: request.abortSignal
					? AbortSignal.any([request.abortSignal as AbortSignal, deadline])
					: deadline,
			});
			const headers = createHttpHeaders(Object.fromEntries(res.headers));
			const streamed =
				request.streamResponseStatusCodes?.has(res.status) ||
				request.streamResponseStatusCodes?.has(Number.POSITIVE_INFINITY);
			if (streamed && res.body)
				return {
					request,
					status: res.status,
					headers,
					readableStreamBody: Readable.fromWeb(
						res.body as unknown as WebReadableStream<Uint8Array>,
					),
				};
			return {
				request,
				status: res.status,
				headers,
				bodyAsText: await res.text(),
			};
		},
	};
}

/** The headers a 429 names its wait in; the SDK's own retries read the same three. */
const RETRY_AFTER = ["retry-after-ms", "x-ms-retry-after-ms", "retry-after"];

/**
 * A 429 that names no wait, retried on the model calls' schedule
 * (`llm`'s `retry`): its attempts, and a wait doubling from its first with
 * full jitter, never past its cap. The SDK's retries take a 429 only when
 * it names a wait, and the project answers some without one — a memory
 * store throttled by the model behind it refuses `delete_scope` so — which
 * left to the SDK is one refusal and a failed call: an erasure stopped part
 * way for a refusal one more ask would have cleared. A 429 that names a
 * wait is the SDK's, which has already spent its own retries on it.
 */
function unnamedThrottleRetry(
	random: () => number = Math.random,
): PipelinePolicy {
	return {
		name: "unnamedThrottleRetry",
		async sendRequest(request, next) {
			const schedule = (await llmSettings()).retry;
			let delayMs = schedule.initialDelayMs;
			for (let remaining = schedule.maxRetries; ; remaining--) {
				const response = await next(request);
				if (
					response.status !== 429 ||
					remaining <= 0 ||
					request.abortSignal?.aborted ||
					RETRY_AFTER.some((name) => response.headers.has(name))
				)
					return response;
				await Bun.sleep(Math.round(random() * delayMs));
				delayMs = Math.min(
					delayMs * schedule.backoffFactor,
					schedule.maxHonouredDelayMs,
				);
			}
		},
	};
}

const PROJECT = "foundry:project-client";
const OPENAI = "foundry:openai-client";

export function projectClient(): AIProjectClient {
	return processSingleton(
		PROJECT,
		() =>
			new AIProjectClient(foundryEndpoint(), azureCredential(), {
				httpClient: providerHttpClient(),
				retryOptions: { maxRetries: cachedLlmSettings().retry.maxRetries },
				additionalPolicies: [
					{ policy: unnamedThrottleRetry(), position: "perCall" },
				],
			}),
	);
}

const TOKEN = "foundry:token";

/** A bearer for the project's data plane, as the process's identity: what the voice agent's socket is opened with too. */
export function foundryToken(): Promise<string> {
	return processSingleton(TOKEN, () =>
		createEntraTokenProvider({
			credential: azureCredential,
			scope: FOUNDRY_SCOPE,
			hint: "Check that AZURE_CLIENT_ID names the identity and that it holds Foundry User on the project.",
		}),
	)();
}

/** The project's endpoint, `https://<account>.services.ai.azure.com/api/projects/<project>`; throws when none is configured. */
export function foundryProjectEndpoint(): string {
	return foundryEndpoint();
}

export function openaiClient(): OpenAI {
	return processSingleton(OPENAI, () => {
		return new OpenAI({
			baseURL: `${foundryEndpoint()}/openai/v1`,
			apiKey: foundryToken,
			maxRetries: cachedLlmSettings().retry.maxRetries,
			timeout: requestDeadlineMs(),
			fetch: (input, init) => providerFetch()(input as string, init),
		});
	});
}

/** Forget both clients, so the next call reads the environment afresh. For tests. */
export function resetFoundryClients(): void {
	resetSingleton(PROJECT);
	resetSingleton(OPENAI);
	resetSingleton(TOKEN);
}

/**
 * One streamed response, holding a slot of the chat deployment's
 * concurrency cap until the stream ends: the model is busy for the whole of
 * it, not only until the headers arrive. The body is the service's, not the
 * SDK's typed request: an agent reference, structured inputs and the
 * conversation are the Agent Service's fields.
 */
export async function* streamResponse(
	body: Record<string, unknown>,
	signal?: AbortSignal,
	idleMs = STREAM_IDLE_MS,
): AsyncGenerator<{ type: string; [field: string]: unknown }> {
	const release = await roleLimiter("chat").acquire(signal);
	const stalled = new AbortController();
	try {
		const stream = await openaiClient().responses.create(
			{ ...body, stream: true } as Parameters<
				OpenAI["responses"]["create"]
			>[0] & { stream: true },
			{
				signal: signal
					? AbortSignal.any([signal, stalled.signal])
					: stalled.signal,
			},
		);
		for await (const event of withinIdle(stream, idleMs, stalled))
			yield event as unknown as { type: string; [field: string]: unknown };
	} finally {
		release();
	}
}

/**
 * The longest a streamed response may go without an event before it is
 * given up. The service writes an event for each step of its own work —
 * the response made, an item begun, a tool it ran — so a stream silent for
 * this long has stopped rather than paused, and the turn and its slot of
 * the concurrency cap would otherwise be held until the caller left.
 */
const STREAM_IDLE_MS = 300_000;

export class StreamStalled extends Error {
	constructor(idleMs: number) {
		super(`the stream sent nothing for ${idleMs}ms`);
		this.name = "StreamStalled";
	}
}

/** A stream's events, each awaited for at most `idleMs`: past it the request is aborted and the read throws. */
export async function* withinIdle<T>(
	events: AsyncIterable<T>,
	idleMs: number,
	abort: AbortController,
): AsyncGenerator<T> {
	const iterator = events[Symbol.asyncIterator]();
	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new StreamStalled(idleMs)), idleMs);
			});
			let next: IteratorResult<T>;
			try {
				next = await Promise.race([iterator.next(), idle]);
			} finally {
				clearTimeout(timer);
			}
			if (next.done) return;
			yield next.value;
		}
	} catch (err) {
		if (err instanceof StreamStalled) abort.abort(err);
		throw err;
	} finally {
		// Not awaited: a stalled stream's `return` may never settle.
		void iterator.return?.()?.catch?.(() => {});
	}
}

/** The opt-in every call that touches a voice agent carries (preview), its versions' list and delete included. */
const VOICE_AGENTS = "VoiceAgents=V1Preview";

export type AgentKind = "prompt" | "voice";

/** The request options a call on an agent of this kind needs: the voice opt-in, or nothing. */
export function kindOptions(kind: AgentKind) {
	return kind === "voice"
		? { requestOptions: { headers: { "foundry-features": VOICE_AGENTS } } }
		: {};
}

/** A new version of the agent, made from a definition in the service's own field names. */
export async function createAgentVersion(
	name: string,
	definition: { kind: AgentKind },
	metadata: Record<string, string>,
): Promise<string> {
	const created = await projectClient().agents.createVersion(
		name,
		definition as unknown as AgentDefinitionUnion,
		{
			metadata,
			...(definition.kind === "voice"
				? { foundryFeatures: VOICE_AGENTS }
				: // The service refuses a definition naming skills, even none, without the opt-in.
					"skills" in definition
					? { foundryFeatures: "Skills=V1Preview" }
					: {}),
		},
	);
	return created.version;
}

/** Whether `err` is the service answering `status`, from either SDK. */
export function hasStatus(err: unknown, status: number): boolean {
	if (!err || typeof err !== "object") return false;
	const { status: openai, statusCode: rest } = err as {
		status?: unknown;
		statusCode?: unknown;
	};
	return openai === status || rest === status;
}

/** A delete of something already gone: true when it went now, false when there was nothing. */
export async function deleted(call: () => Promise<unknown>): Promise<boolean> {
	try {
		await call();
		return true;
	} catch (err) {
		if (isGone(err)) return false;
		throw err;
	}
}

// A response already deleted answers 400 "<id> not found", not 404.
function isGone(err: unknown): boolean {
	return (
		hasStatus(err, 404) ||
		(hasStatus(err, 400) &&
			/\bnot found\b/i.test(String((err as Error).message)))
	);
}
