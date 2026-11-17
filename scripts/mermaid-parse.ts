/**
 * Parses Mermaid diagrams with the pinned `mermaid`, the way a renderer
 * would before it draws. Reads `[{ where, text }]` as JSON on stdin and
 * prints `[{ where, error }]` for every diagram that does not parse.
 *
 * Its own process, because Mermaid sanitizes labels with DOMPurify and so
 * needs a DOM: the happy-dom window it installs on `globalThis` would
 * otherwise reach every test file sharing `bun test`'s one process.
 */
import { Window } from "happy-dom";

const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { default: mermaid } = await import("mermaid");
mermaid.initialize({ startOnLoad: false });

const diagrams = (await Bun.stdin.json()) as { where: string; text: string }[];
const failures: { where: string; error: string }[] = [];
for (const { where, text } of diagrams)
	try {
		await mermaid.parse(text);
	} catch (error) {
		failures.push({ where, error: String(error).split("\n")[0] ?? "" });
	}
console.log(JSON.stringify(failures));
