import { setProviderFetch } from "@platform/llm";
import { projectRoutes } from "./fake-project";
import { openaiRoutes } from "./fake-responses";
import {
	type FakeState,
	type FoundryAnswer,
	HttpError,
	newState,
	type SeenTurn,
} from "./fake-state";
import { voiceConversationRoutes } from "./fake-voice";

/**
 * Foundry Agent Service, stood in for at the HTTP boundary: the requests
 * `@azure/ai-projects` and the `openai` client make for the project are
 * answered here, through `@platform/llm`'s provider fetch, so both SDKs —
 * their serialisers, their pipelines, the SSE parser, the paging — run for
 * real above it. It implements what the host uses and is strict about it:
 * a bearer on every call, the API version and the preview opt-in headers
 * the SDK sends (a voice agent's on every call that touches one), the
 * fields the service refuses beside an agent reference,
 * the structured inputs a version declares, conversation metadata bounds,
 * a function output only for a call still open, and a response refused
 * while the conversation holds a call nobody answered. What an API delete
 * removes stays in `state.retained`, as the service's run state keeps it
 * until its time to live, so a test can tell what a delete reached from
 * what it could not.
 *
 * Its answers come from a script: words (after a reasoning summary, beside
 * a web search and its citations), calls, or the content filter's refusal.
 * The memory store extracts what `extractor` says from the messages it is
 * handed, after the delay the request names.
 */

export const FAKE_FOUNDRY_ENDPOINT = "https://foundry.test/api/projects/agent";
export const FAKE_RAI_POLICY =
	"/subscriptions/0/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/account/raiPolicies/default-indirect";

export type { FoundryAnswer, SeenTurn } from "./fake-state";

export interface FakeFoundry {
	readonly state: FakeState;
	/** Every request, as `METHOD /path`, oldest first. */
	readonly requests: string[];
	/** Answer every turn with this text from now on. */
	answer(text: string): void;
	/** Answer the next turns with these, in order, then the text again. */
	script(...answers: FoundryAnswer[]): void;
	/** Decide each turn's answer from what the model is shown, when no script is queued. */
	respond(answer: (turn: SeenTurn) => FoundryAnswer): void;
	/** What the memory store keeps from the messages it is handed. */
	extract(extractor: (messages: string[], scope: string) => string[]): void;
	/** The turns the model was asked for, oldest first. */
	turns(): SeenTurn[];
	/** What the memory store was handed, one string per hand-over, oldest first. */
	extractions(): string[];
	/** The conversation gone as one past its time to live is: every call on it answers 404. */
	expire(conversationId: string): void;
	/** Every delete the service was asked for, as `DELETE /path`, oldest first. */
	deletes(): string[];
	/** Fail every request this matches with `status`, until called with null: an outage, for a test of what survives one. */
	failWhen(
		matches: ((method: string, path: string) => boolean) | null,
		status?: number,
	): void;
	/** Route the provider fetch here, and anything not for the project to `others`. Returns the undo. */
	install(
		others?: (request: Request) => Response | Promise<Response>,
	): () => void;
	fetch(request: Request): Promise<Response>;
}

function nobodyElse(request: Request): Response {
	return Response.json(
		{ error: { message: `nothing stands in for ${request.url}` } },
		{ status: 404 },
	);
}

export function fakeFoundry(): FakeFoundry {
	const state = newState();
	const requests: string[] = [];
	const routes = [
		...openaiRoutes(state),
		...projectRoutes(state),
		...voiceConversationRoutes(state),
	];
	let outage: {
		matches: (method: string, path: string) => boolean;
		status: number;
	} | null = null;

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = decodeURIComponent(url.pathname).slice(
			new URL(FAKE_FOUNDRY_ENDPOINT).pathname.length,
		);
		requests.push(`${request.method} ${path}`);
		try {
			if (outage?.matches(request.method, path))
				throw new HttpError(outage.status, "the stand-in is in an outage");
			if (!/^Bearer \S+/.test(request.headers.get("authorization") ?? ""))
				throw new HttpError(401, "a bearer token is required");
			for (const route of routes) {
				const match = route.pattern.exec(path);
				if (!match || route.method !== request.method) continue;
				if (route.project && url.searchParams.get("api-version") !== "v1")
					throw new HttpError(400, "api-version=v1 is required");
				if (
					route.feature &&
					request.headers.get("foundry-features") !== route.feature
				)
					throw new HttpError(
						403,
						`this preview needs the foundry-features header ${route.feature}`,
					);
				const body =
					request.method === "GET" || request.method === "DELETE"
						? {}
						: ((await request.json().catch(() => {
								throw new HttpError(400, "the body is not JSON");
							})) as Record<string, unknown>);
				return await route.handle({
					match,
					url,
					headers: request.headers,
					body,
				});
			}
			throw new HttpError(404, `no route for ${request.method} ${path}`);
		} catch (err) {
			if (err instanceof HttpError) return err.response();
			throw err;
		}
	}

	return {
		state,
		requests,
		answer(text) {
			state.reply = { text };
		},
		script(...answers) {
			state.scripted.push(...answers);
		},
		respond(answer) {
			state.responder = answer;
		},
		failWhen(matches, status = 400) {
			outage = matches ? { matches, status } : null;
		},
		extract(extractor) {
			state.extractor = extractor;
		},
		expire(conversationId) {
			state.conversations.delete(conversationId);
			state.retained.push(...(state.items.get(conversationId) ?? []).splice(0));
		},
		deletes: () => requests.filter((r) => r.startsWith("DELETE ")),
		turns: () => state.turns,
		extractions: () => state.extractions,
		install(others = nobodyElse) {
			setProviderFetch(async (input, init) => {
				const request = new Request(String(input), init);
				return request.url.startsWith(FAKE_FOUNDRY_ENDPOINT)
					? handle(request)
					: others(request);
			});
			return () => {
				for (const timer of state.timers) clearTimeout(timer);
			};
		},
		fetch: handle,
	};
}
