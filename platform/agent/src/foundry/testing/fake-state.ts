/**
 * The stand-in's state and the pieces its routes share: what the service
 * holds, the script its model answers from, and the shapes of a refusal.
 */

/** One answer of the stand-in's model. */
export type FoundryAnswer =
	| {
			text: string;
			/** Reasoning summary parts streamed before the words. */
			reasoning?: string[];
			/** A web search the service ran, and the pages the words cite. */
			web?: { url: string; title: string }[];
			/** For a run somebody watches: a wait before the first event, and between words. */
			pace?: { beforeMs?: number; wordMs?: number };
			/** The filter stops the reply on the way out: the words stream, then the response ends incomplete, `content_filter`. */
			filtered?: boolean;
	  }
	| {
			calls: { id: string; name: string; args: Record<string, unknown> }[];
			/** Words the model wrote before the calls, in the same response. */
			text?: string;
			reasoning?: string[];
			pace?: { beforeMs?: number; wordMs?: number };
	  }
	/** The content filter's refusal of the prompt, naming the category. */
	| { blocked: string }
	/** The service failing the request with this status. */
	| { status: number };

/** What the model was shown on one turn. */
export interface SeenTurn {
	/** The version's instructions, the structured inputs filled in. */
	instructions: string;
	/** Everything the model reads: the history the backend sent, or the conversation's items before the response, then the response's input. */
	items: Record<string, unknown>[];
	input: Record<string, unknown>[];
	agent: { name: string; version: string };
	/** The request's body as sent. */
	body: Record<string, unknown>;
}

export interface VersionRecord {
	object: "agent.version";
	id: string;
	name: string;
	version: string;
	created_at: number;
	definition: Record<string, unknown>;
	metadata: Record<string, string>;
}

export interface MemoryRecord {
	memory_id: string;
	scope: string;
	content: string;
	kind: string;
	updated_at: number;
	store: string;
}

/** One update of the memory store: waiting out its delay, superseded by a newer one for its scope, or done. */
export interface UpdateRecord {
	update_id: string;
	store: string;
	scope: string;
	status: "queued" | "completed" | "superseded";
	superseded_by?: string;
	/** What it extracts from: its own messages after those of every update it superseded. */
	messages: string[];
	/** What it wrote, once completed. */
	written: MemoryRecord[];
	timer?: ReturnType<typeof setTimeout>;
}

export interface SkillRecord {
	name: string;
	created_at: number;
	default_version: string;
	versions: {
		version: string;
		description: string;
		instructions: string;
		metadata: Record<string, string>;
		created_at: number;
	}[];
}

export interface FakeState {
	agents: Map<string, VersionRecord[]>;
	/** The last version number each agent was given: the service never reuses one. */
	versionSeq: Map<string, number>;
	/** How many of each agent's newest versions its listing leaves out, as the service's listing trails a version just made. A read by number sees them. */
	listingLag: number;
	stores: Map<string, Record<string, unknown>>;
	memories: Map<string, MemoryRecord>;
	updates: Map<string, UpdateRecord>;
	skills: Map<string, SkillRecord>;
	conversations: Map<
		string,
		{ id: string; created_at: number; metadata: Record<string, string> }
	>;
	/** Each conversation's items, oldest first. */
	items: Map<string, Record<string, unknown>[]>;
	/**
	 * What the service's run state still holds after an API delete: every
	 * item deleted, and every item of a conversation deleted or expired,
	 * until its time to live runs out — which here it never does.
	 */
	retained: Record<string, unknown>[];
	responses: Map<string, { id: string; conversation: string }>;
	reply: FoundryAnswer;
	scripted: FoundryAnswer[];
	responder: ((turn: SeenTurn) => FoundryAnswer) | null;
	extractor: (messages: string[], scope: string) => string[];
	turns: SeenTurn[];
	extractions: string[];
	timers: Set<ReturnType<typeof setTimeout>>;
	nextId: number;
}

export function newState(): FakeState {
	return {
		agents: new Map(),
		versionSeq: new Map(),
		listingLag: 0,
		stores: new Map(),
		memories: new Map(),
		updates: new Map(),
		skills: new Map(),
		conversations: new Map(),
		items: new Map(),
		retained: [],
		responses: new Map(),
		reply: { text: "ok" },
		scripted: [],
		responder: null,
		extractor: () => [],
		turns: [],
		extractions: [],
		timers: new Set(),
		nextId: 1,
	};
}

export function mintId(state: FakeState, prefix: string): string {
	return `${prefix}_${String(state.nextId++).padStart(6, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** The service's clock: whole seconds since the epoch. */
export function seconds(): number {
	return Math.floor(Date.now() / 1000);
}

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
	) {
		super(message);
	}

	response(): Response {
		return Response.json(
			{ error: { code: this.code ?? null, message: this.message } },
			{ status: this.status },
		);
	}
}

export function ok(
	body: unknown,
	status = 200,
	headers?: Record<string, string>,
): Response {
	return Response.json(body, { status, headers });
}

export interface RouteContext {
	match: RegExpExecArray;
	url: URL;
	headers: Headers;
	body: Record<string, unknown>;
}

export interface Route {
	method: string;
	pattern: RegExp;
	/** A project operation, which carries `api-version`. */
	project?: boolean;
	/** The preview opt-in the SDK sends for it. */
	feature?: string;
	handle(context: RouteContext): Response | Promise<Response>;
}

/**
 * A page of `items`, held oldest first, as the SDKs read it: `data` in
 * `order`, the ids at either end, and whether more follow. `after` is an
 * item's id, and the page is what comes after it in that order — older
 * items when the order is `desc`. A cursor naming no item is refused rather
 * than read as the start, which would hand a caller its first page again;
 * and `before`, which the conversation items list does not define and the
 * project's lists define but nothing here sends, is refused rather than
 * ignored.
 */
export function page<T extends Record<string, unknown>>(
	items: readonly T[],
	idOf: (item: T) => string,
	url: URL,
	defaultOrder: "asc" | "desc",
): Response {
	const order = url.searchParams.get("order") ?? defaultOrder;
	if (order !== "asc" && order !== "desc")
		throw new HttpError(400, "order is asc or desc");
	if (url.searchParams.has("before"))
		throw new HttpError(400, "this list pages with after only");
	const limit = Number(url.searchParams.get("limit") ?? 20);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new HttpError(400, "limit is 1 to 100");
	const ordered = order === "asc" ? [...items] : [...items].reverse();
	const after = url.searchParams.get("after");
	const at = after === null ? -1 : ordered.findIndex((i) => idOf(i) === after);
	if (after !== null && at < 0) throw new HttpError(400, `after: no ${after}`);
	const start = at + 1;
	const data = ordered.slice(start, start + limit);
	return ok({
		object: "list",
		data,
		first_id: data[0] ? idOf(data[0]) : null,
		last_id: data.at(-1) ? idOf(data.at(-1) as T) : null,
		has_more: start + limit < ordered.length,
	});
}

/** A field a request must carry as a string. */
export function text(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || !value)
		throw new HttpError(400, `${field} is required`);
	return value;
}

/** Metadata within the service's bounds: 16 pairs, keys to 64 characters, values to 512. */
export function metadataOf(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		throw new HttpError(400, "metadata is an object");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > 16)
		throw new HttpError(400, "metadata holds at most 16 pairs");
	for (const [key, v] of entries)
		if (key.length > 64 || typeof v !== "string" || v.length > 512)
			throw new HttpError(400, `metadata.${key} is out of bounds`);
	return Object.fromEntries(entries) as Record<string, string>;
}

/** The three sizes the web search tool documents; anything else the service would refuse. */
export function isSearchContextSize(tool: Record<string, unknown>): boolean {
	return ["low", "medium", "high"].includes(String(tool.search_context_size));
}
