import type {
	CitedSource,
	ToolRunsOn,
	TurnEvent,
} from "../../contract/messages";
import { WEB_SEARCH } from "../../contract/product";
import { problems } from "../../keys";
import { contentFilterRefusal } from "../../turn/blocked";
import {
	citationMarkerFilter,
	withoutCitationMarkers,
} from "../../turn/citation-markers";
import type { InputItem } from "./input";

/**
 * One response's stream as the contract's events, and what the loop needs
 * from it once it ends: the calls the model made, the usage, the words it
 * wrote, and how it ended. Text and reasoning pass through as they arrive;
 * a function call is announced as its item completes, marked with where it
 * runs; a tool the service ran inside the response (web search) is a call
 * and its result at once; the pages the model cited, annotated on its
 * words, are collected for a reader that asks for them (`web-search.ts`).
 * Everything else the service streams about itself is dropped.
 */

/** A server-sent event of the Responses API, as far as this reads it. */
export interface StreamEvent {
	type: string;
	[field: string]: unknown;
}

export interface FunctionCall {
	callId: string;
	name: string;
	/** As the model wrote them: JSON, unvalidated. */
	arguments: string;
}

export interface ResponseUsage {
	inputTokens: number;
	outputTokens: number;
}

export type ResponseEnd =
	| { kind: "completed"; reason: "stop" | "length" }
	| { kind: "failed"; event: Extract<TurnEvent, { type: "error" }> };

export interface ResponseRead {
	responseId: string | null;
	calls: FunctionCall[];
	usage: ResponseUsage | null;
	/** What the model said in this response: the web search tool's answer, and what the memory store is handed. */
	text: string;
	/**
	 * What the response wrote that the next request must be given again, in
	 * order: the reasoning (opaque, `encrypted_content`), the calls and the
	 * answer. A tool the service ran inside the response is not among them:
	 * its result is already in the answer.
	 */
	items: InputItem[];
	end: ResponseEnd;
}

export interface ReadOptions {
	/** Where a function the model called runs. */
	runsOn(name: string): ToolRunsOn;
	/** Where the pages the model cited are collected, across the reads, each page once. None: they are not read. */
	cited?: CitedSource[];
	/** The caller's own stop: a stream it ends is not a failure of the service's. */
	signal?: AbortSignal;
	emit(event: TurnEvent): void;
}

/** The turn's end when the service refused it: blocked when its content filter said so, failed otherwise. */
export function failureEvent(
	error: unknown,
	reason: string,
): Extract<TurnEvent, { type: "error" }> {
	const filtered = contentFilterRefusal(error);
	if (filtered) {
		problems.report("agent.turn.blocked", { reason: "content_filter" });
		console.warn(
			"[agent] the content filter blocked a turn:",
			filtered.categories.join(", ") || "no category named",
		);
		return { type: "error", code: "turn.blocked" };
	}
	problems.report("agent.turn.failed", { reason });
	console.error(
		`[agent] a response failed (${reason}):`,
		(error as Error)?.message ?? JSON.stringify(error),
	);
	return { type: "error", code: "turn.failed" };
}

/**
 * The turn's end when the caller stopped it — the person pressed stop, or
 * their connection went: the run ends as one that did not finish, and no
 * problem is reported, because nothing failed.
 */
function stoppedEvent(): Extract<TurnEvent, { type: "error" }> {
	console.info("[agent] a response was stopped by its caller");
	return { type: "error", code: "turn.failed" };
}

function argsOf(text: string): unknown {
	try {
		return JSON.parse(text || "{}");
	} catch {
		return text;
	}
}

/** A tool the service runs inside the response, by its item's type: web search is the product's key for it. */
function serviceToolName(itemType: string): string {
	return itemType.startsWith("web_search")
		? WEB_SEARCH
		: itemType.replace(/_call$/, "");
}

type Item = {
	type?: string;
	id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	status?: string;
	role?: string;
	content?: { type?: string; text?: string }[];
	encrypted_content?: string;
	summary?: { type: "summary_text"; text: string }[];
};

/** An output item as the next request takes it, or null for one it does not take. */
function carried(item: Item): InputItem | null {
	switch (item.type) {
		case "reasoning":
			return typeof item.encrypted_content === "string" && item.id
				? {
						type: "reasoning",
						id: item.id,
						encrypted_content: item.encrypted_content,
						summary: item.summary ?? [],
					}
				: null;
		case "function_call":
			return item.call_id && item.name
				? {
						type: "function_call",
						call_id: item.call_id,
						name: item.name,
						arguments: item.arguments ?? "",
					}
				: null;
		case "message": {
			// Kept as it was shown: without the markers the stream took out.
			const text = withoutCitationMarkers(
				(item.content ?? [])
					.map((part) => (typeof part.text === "string" ? part.text : ""))
					.join(""),
			);
			return text
				? { type: "message", role: "assistant", content: text }
				: null;
		}
		default:
			return null;
	}
}

export async function readResponse(
	events: AsyncIterable<StreamEvent>,
	options: ReadOptions,
): Promise<ResponseRead> {
	const read: Omit<ResponseRead, "end"> = {
		responseId: null,
		calls: [],
		usage: null,
		text: "",
		items: [],
	};
	let end: ResponseEnd | null = null;
	const seen = new Set<string>();
	const kept = new Set<string>();

	function call(item: Item): void {
		if (!item.call_id || !item.name || seen.has(item.call_id)) return;
		seen.add(item.call_id);
		const fn = {
			callId: item.call_id,
			name: item.name,
			arguments: item.arguments ?? "",
		};
		read.calls.push(fn);
		options.emit({
			type: "tool-call",
			id: fn.callId,
			name: fn.name,
			args: argsOf(fn.arguments),
			runsOn: options.runsOn(fn.name),
		});
	}

	function cite(annotation: {
		type?: string;
		url?: string;
		title?: string;
	}): void {
		const cited = options.cited;
		if (!cited || annotation.type !== "url_citation" || !annotation.url) return;
		if (cited.some((c) => c.url === annotation.url)) return;
		cited.push({ url: annotation.url, title: annotation.title ?? "" });
	}

	function serviceCall(item: Item): void {
		if (!item.id || seen.has(item.id)) return;
		seen.add(item.id);
		const name = serviceToolName(item.type ?? "");
		options.emit({
			type: "tool-call",
			id: item.id,
			name,
			args: {},
			runsOn: "service",
		});
		options.emit({
			type: "tool-result",
			id: item.id,
			name,
			result: { status: item.status ?? "completed" },
			isError: item.status === "failed",
			runsOn: "service",
		});
	}

	function itemDone(item: Item): void {
		const key = item.id ?? item.call_id;
		const next = carried(item);
		if (next && key && !kept.has(key)) {
			kept.add(key);
			read.items.push(next);
		}
		if (item.type === "function_call") call(item);
		else if (item.type?.endsWith("_call")) serviceCall(item);
	}

	const markers = citationMarkerFilter();
	function text(delta: string): void {
		const shown = markers.push(delta);
		if (!shown) return;
		read.text += shown;
		options.emit({ type: "text", text: shown });
	}

	try {
		for await (const event of events) {
			if (end) continue;
			const response = event.response as
				| {
						id?: string;
						output?: Item[];
						usage?: Record<string, number>;
						error?: unknown;
						incomplete_details?: { reason?: string };
				  }
				| undefined;
			switch (event.type) {
				case "response.created":
					read.responseId = response?.id ?? null;
					break;
				case "response.output_text.delta":
					if (typeof event.delta === "string" && event.delta) text(event.delta);
					break;
				case "response.reasoning_summary_text.delta":
					if (typeof event.delta === "string" && event.delta)
						options.emit({
							type: "reasoning",
							id: `${event.item_id}:${event.summary_index}`,
							text: event.delta,
						});
					break;
				case "response.output_item.done":
					itemDone((event.item ?? {}) as Item);
					break;
				case "response.output_text.annotation.added":
					cite((event.annotation ?? {}) as Record<string, string>);
					break;
				case "response.completed":
				case "response.incomplete": {
					read.responseId = response?.id ?? read.responseId;
					for (const item of response?.output ?? []) itemDone(item);
					const usage = response?.usage;
					read.usage = usage
						? {
								inputTokens: usage.input_tokens ?? 0,
								outputTokens: usage.output_tokens ?? 0,
							}
						: null;
					const reason = response?.incomplete_details?.reason;
					end =
						reason === "content_filter"
							? {
									kind: "failed",
									event: failureEvent(
										{ code: "content_filter" },
										"content_filter",
									),
								}
							: {
									kind: "completed",
									reason:
										event.type === "response.incomplete" ? "length" : "stop",
								};
					break;
				}
				case "response.failed":
					read.responseId = response?.id ?? read.responseId;
					end = {
						kind: "failed",
						event: failureEvent(response?.error, "response"),
					};
					break;
				case "error":
					end = { kind: "failed", event: failureEvent(event, "stream") };
					break;
			}
		}
	} catch (err) {
		end ??= {
			kind: "failed",
			event: options.signal?.aborted
				? stoppedEvent()
				: failureEvent(err, "stream"),
		};
	}
	const held = markers.flush();
	if (held) {
		read.text += held;
		options.emit({ type: "text", text: held });
	}
	end ??= {
		kind: "failed",
		event: options.signal?.aborted
			? stoppedEvent()
			: failureEvent(
					new Error("the stream ended before the response did"),
					"stream",
				),
	};
	// A response that did not complete may have ended between a reasoning
	// item and the item it reasoned towards. The model takes no reasoning
	// without what follows it, so one left last is not carried.
	if (end.kind === "failed")
		while (read.items.at(-1)?.type === "reasoning") read.items.pop();
	return { ...read, end };
}
