import { describe, expect, test } from "bun:test";

/*
 * The composer's row, laid out from its own sheet: every control in it is
 * centred on the field's last line — the only line at first, the line being
 * written once the words grow — at every text size and on a fine or a
 * coarse pointer, and the add and the send are the same size, the same
 * distance in from the field's edges. The arithmetic is the flex layout's:
 * the box and the side align their items to the row's foot.
 */
const here = (p: string) => new URL(p, import.meta.url);
const chat = await Bun.file(here("./chat.css")).text();
const tokens = await Bun.file(here("../../globals.css")).text();
const composer = await Bun.file(here("./Composer.tsx")).text();

function block(css: string, selector: string): string {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
	const match = text.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
	if (!match) throw new Error(`no rule for ${selector}`);
	return match[1] ?? "";
}

function decl(body: string, prop: string): string {
	const match = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`));
	if (!match) throw new Error(`no ${prop}`);
	return (match[1] ?? "").replace(/\s+/g, " ").trim();
}

/** A length in px, given the custom properties in scope and the root's text size. */
function length(
	value: string,
	scope: Record<string, string>,
	textScale: number,
): number {
	let expr = value;
	for (let depth = 0; expr.includes("var(") && depth < 10; depth++)
		expr = expr.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
			const bound = scope[name];
			if (bound === undefined) throw new Error(`unbound ${name}`);
			return `(${bound})`;
		});
	expr = expr
		.replace(/(\d*\.?\d+)rem/g, (_, n: string) => `(${n}*${16 * textScale})`)
		.replace(/(\d*\.?\d+)px/g, "$1")
		.replace(/\bcalc\(/g, "(")
		.replace(/\bmax\(/g, "Math.max(")
		.replace(/\bmin\(/g, "Math.min(");
	if (!/^[\d\s.+\-*/(),]*$/.test(expr.replace(/Math\.m(ax|in)/g, "")))
		throw new Error(`not arithmetic: ${expr}`);
	return Function(`return (${expr});`)() as number;
}

/** A shorthand's values, split on the spaces outside any parentheses. */
function topLevel(value: string): string[] {
	const parts = [""];
	let depth = 0;
	for (const ch of value) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === " " && depth === 0) parts.push("");
		else parts[parts.length - 1] += ch;
	}
	return parts;
}

function rootTokens(): Record<string, string> {
	const root = block(tokens, ":root");
	return Object.fromEntries(
		[...root.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
			m[1] as string,
			(m[2] as string).trim(),
		]),
	);
}

const row = block(chat, ".composer-row");
const box = block(chat, ".composer-box");
const field = block(chat, ".composer-text");
const side = block(chat, ".composer-side");
const buttons = block(chat, ".composer-box > .menu,\n.composer-send");

function layout(textScale: number, controlH: number, lines: number) {
	const scope: Record<string, string> = {
		...rootTokens(),
		"--control-h": `${controlH}px`,
	};
	for (const [, name, value] of row.matchAll(/(--[\w-]+):\s*([^;]+);/g))
		scope[name as string] = (value as string).replace(/\s+/g, " ").trim();
	const px = (v: string) => length(v, scope, textScale);
	const line = length(decl(field, "line-height"), scope, textScale);
	const fieldPad = px(topLevel(decl(field, "padding"))[0] as string);
	const fieldMin = px(decl(field, "min-height"));
	const inset = px(decl(box, "padding"));
	const roundH = px("var(--control-h-sm)");
	const roundBelow = px(decl(buttons, "margin-bottom"));
	const sideBelow = px(decl(side, "margin-bottom"));
	const border = 1;
	const fieldH = Math.max(fieldMin, lines * line + 2 * fieldPad);
	const lastLine = border + inset + fieldPad + line / 2;
	return {
		lastLine,
		round: border + inset + roundBelow + roundH / 2,
		side: sideBelow + controlH / 2,
		oneLineBox: 2 * border + 2 * inset + fieldH,
		roundFits: roundH + roundBelow <= fieldH + 0.001,
	};
}

describe("the composer's row", () => {
	for (const textScale of [1, 1.15, 1.3, 1.5])
		for (const controlH of [40, 44])
			for (const lines of [1, 3])
				test(`centres every control on the last line — text ×${textScale}, ${controlH}px controls, ${lines} line(s)`, () => {
					const at = layout(textScale, controlH, lines);
					expect(at.round).toBeCloseTo(at.lastLine, 5);
					expect(at.side).toBeCloseTo(at.lastLine, 5);
					expect(at.roundFits).toBe(true);
				});

	test("at one line on a coarse pointer the field is exactly the side buttons' height", () => {
		expect(layout(1, 44, 1).oneLineBox).toBe(44);
	});

	test("the box and the side stand at the row's foot, the add menu is its button's box", () => {
		expect(decl(row, "align-items")).toBe("flex-end");
		expect(decl(box, "align-items")).toBe("flex-end");
		expect(decl(block(chat, ".composer-box > .menu"), "display")).toBe("flex");
		expect(chat).not.toMatch(/(margin|padding)-bottom:\s*1px/);
	});

	test("the add and the send are one size", () => {
		const sizes = [
			...composer.matchAll(
				/<IconButton([^>]*?)className="composer-(add|send)"/gs,
			),
		].map((m) => m[1]?.match(/size="(\w+)"/)?.[1]);
		expect(sizes.length).toBe(3);
		expect(new Set(sizes)).toEqual(new Set(["sm"]));
	});
});
