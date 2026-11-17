/**
 * What crosses the host's boundary, in both directions, with no framework
 * type on either side: the messages a backend hands a turn, and the events
 * it forwards back.
 */

export type TurnRole = "user" | "assistant";

export type TurnPart =
	| { type: "text"; text: string }
	/** A picture for this turn only, as a `data:` URL. It reaches the model once; the thread keeps only that there was one. */
	| { type: "image"; data: string; mediaType: string };

export type TurnMessage =
	| {
			/** The client's id for the message, stable across a retry of the same request. */
			id?: string;
			role: TurnRole;
			content: string | TurnPart[];
	  }
	/**
	 * What a control the client runs answered. A turn that carries one carries
	 * only these, one for each call the agent left open for the client; the
	 * host refuses anything else as `turn.invalid`.
	 */
	| { id?: string; role: "tool"; toolCallId: string; content: string };

/** One line of what the interface says is on the person's screen. */
export interface LiveContextLine {
	label: string;
	value: string;
}

/** A web page the model cited while it searched the web: what `searchTheWeb` answers beside its words. */
export interface CitedSource {
	url: string;
	title: string;
}

/** A library document an answer drew on, as the interface shows it: a chip that opens the document. */
export interface DocumentSource {
	id: string;
	title: string;
	thumbnailUrl?: string;
}

export interface TurnUsage {
	inputTokens: number | null;
	outputTokens: number | null;
}

/**
 * Where a tool ran: a product tool in the backend; a control in the
 * person's browser, whose call ends the run and is answered by a turn of
 * the client's own; or a tool the model service runs itself.
 */
export type ToolRunsOn = "server" | "client" | "service";

export type TurnEvent =
	| { type: "text"; text: string }
	/** The model's reasoning summary, a delta at a time. A new `id` is a new part. */
	| { type: "reasoning"; id: string; text: string }
	| {
			type: "tool-call";
			id: string;
			name: string;
			args: unknown;
			runsOn: ToolRunsOn;
	  }
	| {
			type: "tool-result";
			id: string;
			name: string;
			result: unknown;
			isError: boolean;
			runsOn: ToolRunsOn;
	  }
	/** Once per turn, before `finish`, and only when an answer drew on a document: each once. */
	| { type: "sources"; sources: DocumentSource[] }
	| { type: "finish"; reason: string; usage: TurnUsage }
	/**
	 * The turn ended without an answer: `turn.blocked` when the content
	 * filter refused it, `turn.failed` for anything else. The filter's
	 * category and every other cause stay on the server.
	 */
	| { type: "error"; code: "turn.failed" | "turn.blocked" };

/** A stored message, as a thread is read back. */
export interface ThreadMessage {
	id: string;
	role: TurnRole;
	text: string;
	/** Pictures this message carried when it was sent; none of them was kept. */
	imageSlots: number;
	createdAt: string;
}
