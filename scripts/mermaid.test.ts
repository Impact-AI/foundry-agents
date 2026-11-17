/**
 * Every Mermaid diagram in the repository's Markdown parses. GitHub draws a
 * diagram that does not parse as an error box, and nothing else notices: a
 * `;` inside a sequence diagram's message ends the statement, so the rest of
 * the line is read as the next one. The parser is the pinned `mermaid`, run
 * in a child process because it needs a DOM (`mermaid-parse.ts`).
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SKIP = new Set([".git", "node_modules", "dist", ".next", "coverage"]);

function markdown(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name) || name.startsWith(".next")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) markdown(path, out);
		else if (name.endsWith(".md")) out.push(path);
	}
	return out;
}

type Diagram = { where: string; text: string };

/**
 * Every fenced `mermaid` block in a page, named by its file and line. A fence
 * is one wherever Markdown takes it as one: backticks or tildes, indented
 * inside a list, with spaces after the word, in a file with either line
 * ending. The block's own indentation is taken off its lines.
 */
export function diagrams(file: string, text: string): Diagram[] {
	const out: Diagram[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const open = /^(\s*)(`{3,}|~{3,})\s*mermaid\s*$/.exec(lines[i] ?? "");
		if (!open) continue;
		const [, indent = "", fence = ""] = open;
		const body: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const line = lines[j] ?? "";
			const mark = line.trim();
			if (mark.startsWith(fence) && /^(`+|~+)$/.test(mark)) break;
			body.push(line.startsWith(indent) ? line.slice(indent.length) : line);
		}
		out.push({ where: `${file}:${i + 1}`, text: `${body.join("\n")}\n` });
		i = j;
	}
	return out;
}

/** How many times a page opens a fence it calls mermaid, however it is written. */
const opened = (text: string) =>
	[...text.matchAll(/(?:`{3,}|~{3,})[ \t]*mermaid\b/g)].length;

async function parseErrors(
	list: Diagram[],
): Promise<{ where: string; error: string }[]> {
	const child = Bun.spawn(["bun", join(import.meta.dir, "mermaid-parse.ts")], {
		cwd: ROOT,
		stdin: new Blob([JSON.stringify(list)]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`the parser exited ${code}: ${err}`);
	return JSON.parse(out);
}

const pages = markdown(ROOT).map((path) => ({
	file: relative(ROOT, path),
	text: readFileSync(path, "utf8"),
}));
const all = pages.flatMap(({ file, text }) => diagrams(file, text));

test("the documentation has diagrams to check", () => {
	expect(all.length).toBeGreaterThan(5);
});

test("a fence is read wherever Markdown takes it as one, and every fence a page opens is read", () => {
	const sound = "flowchart LR\n  a --> b\n";
	for (const page of [
		`\`\`\`mermaid\n${sound}\`\`\`\n`,
		`\`\`\`mermaid  \n${sound}\`\`\`\n`,
		`~~~mermaid\n${sound}~~~\n`,
		`\`\`\`mermaid\r\n${sound.replaceAll("\n", "\r\n")}\`\`\`\r\n`,
		`- a step\n\n  \`\`\`mermaid\n  flowchart LR\n    a --> b\n  \`\`\`\n`,
	])
		expect(diagrams("page.md", page).map((d) => d.text)).toEqual([sound]);
	expect(
		diagrams("page.md", `one\n\n\`\`\`mermaid\n${sound}\`\`\`\n`)[0]?.where,
	).toBe("page.md:3");
	expect(diagrams("page.md", `\`\`\`ts\n${sound}\`\`\`\n`)).toEqual([]);
	// A fence this reader does not take as one would be a diagram nobody parses.
	for (const { file, text } of pages)
		expect(diagrams(file, text).length, file).toBe(opened(text));
});

test("the parser refuses a broken diagram and accepts a sound one", async () => {
	const errors = await parseErrors([
		{ where: "semicolon", text: "sequenceDiagram\n  A->>B: one; two\n" },
		{ where: "arrow", text: "flowchart LR\n  a -=> b\n" },
		{ where: "sound", text: "sequenceDiagram\n  A->>B: one — two\n" },
		{
			where: "subgraph",
			text: "flowchart LR\n  subgraph s [S]\n    a\n  end\n  s --> b\n",
		},
	]);
	expect(errors.map((e) => e.where)).toEqual(["semicolon", "arrow"]);
}, 30_000);

test("every Mermaid diagram in the Markdown parses", async () => {
	expect(await parseErrors(all)).toEqual([]);
}, 30_000);
