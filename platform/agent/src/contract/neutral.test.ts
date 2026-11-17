import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The contract is what a second host is written against, so nothing it
 * reaches may come from the first one. Read from the source: every relative
 * import, followed from the contract, the interfaces of the two stores and
 * the turn's shared rules, for as far as it goes.
 */

const SRC = resolve(import.meta.dir, "..");
const IMPORT = /(?:from|import)\s+"(\.{1,2}\/[^"]+)"/g;

/** The two modules whose job is to choose an implementation. */
const CHOOSERS = new Set(["memory/select.ts", "history/select.ts"]);

function sources(dir: string): string[] {
	return readdirSync(join(SRC, dir))
		.filter((name) => name.endsWith(".ts") && !name.includes(".test."))
		.map((name) => `${dir}/${name}`);
}

function target(from: string, specifier: string): string | null {
	const base = resolve(SRC, dirname(from), specifier);
	for (const candidate of [`${base}.ts`, join(base, "index.ts")])
		if (existsSync(candidate) && statSync(candidate).isFile())
			return relative(SRC, candidate);
	return null;
}

function importsOf(file: string): string[] {
	const text = readFileSync(join(SRC, file), "utf8");
	return [...text.matchAll(IMPORT)].flatMap((match) => {
		const found = target(file, match[1] as string);
		return found ? [found] : [];
	});
}

/** Every module reached from `roots`, with the module that led to it. */
function reached(roots: readonly string[]): Map<string, string> {
	const via = new Map<string, string>(roots.map((root) => [root, root]));
	const queue = [...roots];
	for (let file = queue.shift(); file; file = queue.shift())
		for (const next of importsOf(file))
			if (!via.has(next)) {
				via.set(next, file);
				queue.push(next);
			}
	return via;
}

const ROOTS = [
	...sources("contract").filter((file) => file !== "contract/parity.ts"),
	...sources("turn"),
	"memory/interface.ts",
	"history/interface.ts",
];

test("nothing the contract, the stores' interfaces or the turn's rules reach is the Foundry host's", () => {
	expect(ROOTS.length).toBeGreaterThan(8);
	const fromFoundry = [...reached(ROOTS)]
		.filter(([file]) => file.startsWith("foundry/"))
		.map(([file, via]) => `${via} -> ${file}`);
	expect(fromFoundry).toEqual([]);
});

test("outside the Foundry host, only the two choosers and the test stand-ins import from it", () => {
	const outside = ["", ...readdirSync(SRC)]
		.filter(
			(dir) =>
				dir !== "foundry" &&
				dir !== "testing" &&
				statSync(join(SRC, dir)).isDirectory(),
		)
		.flatMap((dir) => sources(dir || "."))
		.map((file) => file.replace(/^\.\//, ""));
	expect(outside.length).toBeGreaterThan(30);
	const importers = outside.filter((file) =>
		importsOf(file).some((found) => found.startsWith("foundry/")),
	);
	expect(new Set(importers)).toEqual(CHOOSERS);
});
