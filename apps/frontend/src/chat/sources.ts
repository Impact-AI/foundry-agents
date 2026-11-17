import { isSameOriginPath } from "../same-origin";

/** A library document a reply drew on: the chip under the reply opens it. */
export interface DocumentSource {
	id: string;
	title: string;
	thumbnailUrl?: string;
}

/**
 * The `sources` custom event's value, read as data: one document per
 * entry with an id and a title, and a thumbnail only when it is a path on
 * this origin — a picture is fetched from the media route or not at all.
 * Anything else in the list is dropped; a value that is no list is none.
 */
export function readSources(value: unknown): DocumentSource[] {
	if (!Array.isArray(value)) return [];
	const out: DocumentSource[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const { id, title, thumbnailUrl } = entry as Record<string, unknown>;
		if (typeof id !== "string" || !id || typeof title !== "string") continue;
		out.push({
			id,
			title,
			...(typeof thumbnailUrl === "string" && isSameOriginPath(thumbnailUrl)
				? { thumbnailUrl }
				: {}),
		});
	}
	return out;
}

/** The two lists as one, each document once, in the order it first came. */
export function mergeSources(
	held: readonly DocumentSource[],
	more: readonly DocumentSource[],
): DocumentSource[] {
	const seen = new Set(held.map((s) => s.id));
	return [...held, ...more.filter((s) => !seen.has(s.id) && seen.add(s.id))];
}

/**
 * The message a run's sources are drawn under: the run's last assistant
 * message, which is the reply the event follows. Null for a run that has
 * written no assistant message yet, whose sources have nowhere to go.
 */
export function sourcesOwner(
	messages: readonly { id: string; role: string }[],
): string | null {
	return messages.findLast((m) => m.role === "assistant")?.id ?? null;
}
