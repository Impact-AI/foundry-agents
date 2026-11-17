import { expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * A write of the account's row that a request makes names the account its
 * gate admitted the request on (`auth/standing`'s `stillAdmitted` says
 * why): `updatePerson` and `setVoiceTuning` take it as their third argument,
 * and with none they would write to whatever account the id holds by then.
 * Read off the source, so a route added later is held to it too.
 */
const WRITES = ["updatePerson", "setVoiceTuning"];

/** The text of each call's arguments, up to its closing parenthesis. */
function callsOf(source: string, name: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
		let depth = 1;
		let at = (match.index ?? 0) + match[0].length;
		const start = at;
		while (at < source.length && depth > 0) {
			const ch = source[at];
			if (ch === "(" || ch === "{" || ch === "[") depth++;
			else if (ch === ")" || ch === "}" || ch === "]") depth--;
			at++;
		}
		found.push(source.slice(start, at - 1));
	}
	return found;
}

/** How many arguments a call's text holds: its commas at the top level, plus one. */
function argumentCount(args: string): number {
	let depth = 0;
	let count = args.trim() ? 1 : 0;
	for (const ch of args) {
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) count++;
	}
	// A trailing comma is not an argument.
	if (/,\s*$/.test(args)) count--;
	return count;
}

test("every write of the account's row a request makes names the account its gate admitted", async () => {
	let seen = 0;
	for await (const path of new Glob("**/*.ts").scan({ cwd: import.meta.dir })) {
		if (path.endsWith(".test.ts") || path.startsWith("testing/")) continue;
		const source = await Bun.file(`${import.meta.dir}/${path}`).text();
		for (const name of WRITES)
			for (const args of callsOf(source, name)) {
				seen++;
				expect({ path, name, args: argumentCount(args) }).toEqual({
					path,
					name,
					args: 3,
				});
			}
	}
	// The routes that write the row are found at all.
	expect(seen).toBeGreaterThanOrEqual(2);
});
