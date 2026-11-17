import { completion } from "@platform/llm/testing";
import { EXTRACTION_OPENING } from "../memory/extract";

/**
 * The extraction's model call, stood in for at the provider fetch: a
 * request whose system message opens as the extraction prompt does is
 * answered with what `extract` says of the messages it was handed, as
 * facts the person stated about themselves. Every other request is somebody else's (`null`).
 */
export interface StandInExtractor {
	/** What the extractor was handed, one string per call, oldest first: `role: words` lines. */
	readonly handed: string[];
	/** Decide what is kept from the lines handed and what was kept so far: the whole list, as the model answers it. */
	extract(extractor: (messages: string[], kept: string[]) => string[]): void;
	/** Answer nothing until `open` settles; null answers at once again. A race's other half. */
	waitFor(open: Promise<void> | null): void;
	fetch(request: Request): Promise<Response | null>;
}

const KEPT_HEADING = "Kept so far:\n";
const MESSAGES_HEADING = "\n\nLatest messages:\n";

/** The text of a Responses API request's input of `role`, whichever shape the SDK sent it in. */
function inputText(input: unknown, role: string): string {
	if (!Array.isArray(input)) return "";
	return input
		.filter((item: { role?: unknown }) => item.role === role)
		.map((item: { content?: unknown }) =>
			typeof item.content === "string"
				? item.content
				: Array.isArray(item.content)
					? item.content
							.map((part: { text?: unknown }) =>
								typeof part.text === "string" ? part.text : "",
							)
							.join("")
					: "",
		)
		.join("\n");
}

export function standInExtractor(
	extractor: (messages: string[], kept: string[]) => string[] = () => [],
): StandInExtractor {
	const handed: string[] = [];
	let extract = extractor;
	let gate: Promise<void> | null = null;
	return {
		handed,
		extract(next) {
			extract = next;
		},
		waitFor(open) {
			gate = open;
		},
		async fetch(request) {
			if (!/\/responses(\?|$)/.test(request.url)) return null;
			const body = (await request.clone().json()) as { input?: unknown };
			if (!inputText(body.input, "developer").startsWith(EXTRACTION_OPENING))
				return null;
			const text = inputText(body.input, "user");
			const at = text.indexOf(MESSAGES_HEADING);
			const kept = text
				.slice(KEPT_HEADING.length, at)
				.split("\n")
				.flatMap((line) => (line.startsWith("- ") ? [line.slice(2)] : []));
			const messages = text.slice(at + MESSAGES_HEADING.length);
			handed.push(messages);
			if (gate) await gate;
			return completion(
				JSON.stringify({
					facts: extract(messages.split("\n"), kept).map((fact) => ({
						text: fact,
						from: "person",
						kind: "fact",
					})),
				}),
			);
		},
	};
}
