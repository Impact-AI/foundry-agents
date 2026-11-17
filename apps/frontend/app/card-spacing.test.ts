import { describe, expect, test } from "bun:test";

/*
 * One spacing for every card and panel: the gap from a heading (or the
 * sentence under it) to what follows is the card frame's gap, declared once
 * in the token sheet, and nothing else's. The cards are found in the markup
 * — every element that carries `card` or `card-frame`, every head that
 * carries `card-head` — and every hand-written sheet is read for a rule
 * that spaces one of them, or its heading, on its own. Rendered Markdown is
 * prose, not a card, and keeps its own rhythm.
 */
const APP = new URL("./", import.meta.url).pathname;
const PROSE = "components/markdown/markdown.css";

async function read(pattern: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for await (const path of new Bun.Glob(pattern).scan(APP))
		files[path] = await Bun.file(APP + path).text();
	return files;
}

const sheets = await read("**/*.css");
const markup = await read("**/*.tsx");

interface Rule {
	file: string;
	selectors: string[];
	decls: Record<string, string>;
}

/** Every style rule, at-rules opened, as its selector list and declarations. */
function rules(file: string, css: string): Rule[] {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const out: Rule[] = [];
	const stack: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "{") {
			stack.push(text.slice(start, i).trim());
			start = i + 1;
		} else if (text[i] === "}") {
			const prelude = stack.pop() ?? "";
			const body = text.slice(start, i);
			start = i + 1;
			if (prelude.startsWith("@") || body.includes("{")) continue;
			const decls: Record<string, string> = {};
			for (const decl of body.split(";")) {
				const at = decl.indexOf(":");
				if (at < 0) continue;
				decls[decl.slice(0, at).trim()] = decl
					.slice(at + 1)
					.replace(/\s+/g, " ")
					.trim();
			}
			const selectors = prelude.split(",").map((s) => s.trim());
			out.push({ file, selectors, decls });
		}
	}
	return out;
}

const all = Object.entries(sheets)
	.filter(([file]) => file !== PROSE)
	.flatMap(([file, css]) => rules(file, css));

/** The classes that share an element with one of `marks`, across every className in the markup. */
function siblings(marks: string[]): Set<string> {
	const found = new Set<string>();
	for (const source of Object.values(markup))
		for (const [, literal] of source.matchAll(/"([^"\n]*)"/g)) {
			const tokens = (literal ?? "").split(/\s+/).filter(Boolean);
			if (!tokens.some((t) => marks.includes(t))) continue;
			for (const t of tokens)
				if (/^[a-z][\w-]*$/.test(t) && !t.startsWith("card")) found.add(t);
		}
	return found;
}

const frames = siblings(["card", "card-frame"]);
const heads = siblings(["card-head"]);
frames.delete("panel");

/** The shared rule: the token sheet's card section, and nowhere else. */
const isShared = (rule: Rule) =>
	rule.file === "globals.css" &&
	rule.selectors.every((s) => /^\.card(-[\w-]+)?$/.test(s));

/** The last compound of a selector: what the rule actually styles. */
const subject = (selector: string) =>
	selector
		.split(/[\s>+~]+/)
		.filter(Boolean)
		.at(-1) ?? "";

const hasClass = (compound: string, names: Iterable<string>) =>
	[...names].some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(compound));

const isZero = (value: string) => /^0(px)?$/.test(value);

/** Whether a declaration puts space under the box: a bottom margin or padding, by any spelling. */
function spacesBelow(prop: string, value: string): boolean {
	if (/^(margin|padding)-(bottom|block-end)$/.test(prop)) return !isZero(value);
	if (/^(margin|padding)-block$/.test(prop))
		return !isZero(value.split(" ").at(-1) ?? "");
	if (prop === "margin" || prop === "padding") {
		const parts = value.split(" ");
		const bottom = parts.length >= 3 ? parts[2] : parts[0];
		return !isZero(bottom ?? "");
	}
	return false;
}

const spacesAbove = (prop: string, value: string) =>
	/^(margin|padding)(-top|-block-start)?$/.test(prop) &&
	!isZero(value.split(" ")[0] ?? "");

const describeRule = (rule: Rule, prop: string) =>
	`${rule.file}: ${rule.selectors.join(", ")} { ${prop}: ${rule.decls[prop]} }`;

describe("one spacing for every card", () => {
	test("the markup puts every card and panel on the frame", () => {
		for (const surface of [
			"dialog",
			"door-card",
			"stage-tile-inner",
			"chat-pane",
			"guide-card",
			"landing",
		])
			expect(frames).toContain(surface);
		for (const head of ["stage-tile-head", "chat-head", "landing-head"])
			expect(heads).toContain(head);
	});

	test("the frame's gap is the one distance after a head, and the body's rows have theirs", () => {
		const frame = all.find(
			(r) => r.selectors.join(",") === ".card,.card-frame",
		);
		expect(frame?.decls.gap).toBe("var(--card-gap)");
		expect(frame?.decls.padding).toBe("var(--card-pad)");
		const body = all.find((r) => r.selectors.join(",") === ".card-body");
		expect(body?.decls.gap).toBe("var(--card-row-gap)");
		expect(sheets["globals.css"]).toMatch(/--card-gap: var\(--space-\d+\);/);
	});

	test("no card or panel sets its own padding or gap", () => {
		const own = all.flatMap((rule) =>
			isShared(rule) ||
			!rule.selectors.some((s) => hasClass(subject(s), frames))
				? []
				: Object.keys(rule.decls)
						.filter((p) => /^(gap|row-gap|padding(-[\w-]+)?)$/.test(p))
						.map((p) => describeRule(rule, p)),
		);
		expect(own).toEqual([]);
	});

	test("no card heading sets the space after it", () => {
		const own = all.flatMap((rule) => {
			if (isShared(rule)) return [];
			const heading = rule.selectors.some((s) => {
				const last = subject(s);
				return (
					hasClass(last, heads) ||
					/\.card-head/.test(last) ||
					/(^|[.:])(h[1-6]|legend)\b/.test(last) ||
					/^(h[1-6]|legend)/.test(last) ||
					/-heading(?![\w-])/.test(last)
				);
			});
			if (!heading) return [];
			return Object.entries(rule.decls)
				.filter(([p, v]) => spacesBelow(p, v))
				.map(([p]) => describeRule(rule, p));
		});
		expect(own).toEqual([]);
	});

	test("nothing that follows a heading is pushed away from it", () => {
		const own = all.flatMap((rule) =>
			rule.selectors.some((s) =>
				/(h[1-6]|legend|-head|-heading|card-head[\w-]*)\s*\+/.test(s),
			)
				? Object.entries(rule.decls)
						.filter(([p, v]) => spacesAbove(p, v))
						.map(([p]) => describeRule(rule, p))
				: [],
		);
		expect(own).toEqual([]);
	});
});
