/**
 * The model's reasoning in a thread, as one disclosure per turn. A turn is
 * everything after one of the person's messages and before the next; the
 * reasoning parts in it — one per step of a run that calls tools — are read
 * as one summary, drawn where the latest part stands, so the disclosure
 * sits just above what the reasoning led to.
 */

/** The fields of a runtime message this reads. */
export interface ThreadMessage {
	id: string;
	role: string;
	content?: unknown;
}

export interface ReasoningTurn {
	/** The turn's first reasoning part: what names the disclosure, whichever part draws it. */
	key: string;
	/** The part the disclosure is drawn at: the turn's latest. */
	drawnAt: string;
	/** Every part's text, in order; parts that carried none are left out. */
	summary: string;
	/** The run is in flight and the latest thing in the thread is this turn's reasoning. */
	streaming: boolean;
}

/** Each reasoning part's turn, by the part's id. */
export function reasoningTurns(
	messages: readonly ThreadMessage[],
	isRunning: boolean,
): Map<string, ReasoningTurn> {
	const byPart = new Map<string, ReasoningTurn>();
	const last = messages[messages.length - 1];
	let parts: ThreadMessage[] = [];
	const close = () => {
		const first = parts[0];
		const latest = parts[parts.length - 1];
		if (!first || !latest) return;
		const turn: ReasoningTurn = {
			key: first.id,
			drawnAt: latest.id,
			summary: parts
				.map((part) => (typeof part.content === "string" ? part.content : ""))
				.map((text) => text.trim())
				.filter(Boolean)
				.join("\n\n"),
			streaming: isRunning && last?.id === latest.id,
		};
		for (const part of parts) byPart.set(part.id, turn);
		parts = [];
	};
	for (const message of messages) {
		if (message.role === "user") close();
		else if (message.role === "reasoning") parts.push(message);
	}
	close();
	return byPart;
}

/** How long a turn has spent reasoning: the spans it was seen streaming, summed. */
export interface ReasoningClock {
	spentMs: number;
	/** When the span in progress began; null between spans. */
	since: number | null;
}

/** The clock after a look at the turn at `now`; looking twice at the same state changes nothing. */
export function advance(
	clock: ReasoningClock | undefined,
	streaming: boolean,
	now: number,
): ReasoningClock {
	const was = clock ?? { spentMs: 0, since: null };
	if (streaming) return was.since === null ? { ...was, since: now } : was;
	if (was.since === null) return was;
	return { spentMs: was.spentMs + (now - was.since), since: null };
}

export type ReasoningLabel =
	| { key: "thinking" }
	| { key: "briefly" }
	| { key: "seconds"; count: number }
	| { key: "minutes"; count: number }
	| { key: "unmeasured" };

/** What the disclosure says: thinking while it is, then for how long — or nothing about time it never saw. */
export function reasoningLabel(
	streaming: boolean,
	clock: ReasoningClock | undefined,
): ReasoningLabel {
	if (streaming) return { key: "thinking" };
	if (!clock || clock.spentMs === 0) return { key: "unmeasured" };
	const seconds = clock.spentMs / 1000;
	if (seconds < 2) return { key: "briefly" };
	if (seconds < 60) return { key: "seconds", count: Math.round(seconds) };
	return { key: "minutes", count: Math.round(seconds / 60) };
}
