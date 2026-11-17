import { expect, test } from "bun:test";
import { locales as productLocales } from "../backend/src/product/locales";
import { locales } from "./src/i18n/locales";

/**
 * Every user-visible string is in every catalogue: a key one language has
 * and another lacks is a sentence that renders as its own key for somebody.
 */
const HERE = new URL(".", import.meta.url).pathname;

function keysOf(node: unknown, path = ""): string[] {
	if (typeof node === "string") return [path];
	if (!node || typeof node !== "object") return [];
	return Object.entries(node).flatMap(([k, v]) =>
		keysOf(v, path ? `${path}.${k}` : k),
	);
}

async function catalogue(locale: string): Promise<string[]> {
	return keysOf(await Bun.file(`${HERE}messages/${locale}.json`).json()).sort();
}

test("this app's languages are the product's own list, not a copy of it", () => {
	expect(locales).toBe(productLocales);
});

test("the registry lists exactly the catalogues that exist", async () => {
	const catalogues = [];
	for await (const file of new Bun.Glob("*.json").scan(`${HERE}messages`))
		catalogues.push(file.replace(/\.json$/, ""));
	expect(catalogues.sort()).toEqual([...locales.codes].sort());
});

test("every catalogue carries the same keys as English", async () => {
	const english = await catalogue("en");
	expect(english.length).toBeGreaterThan(50);
	for (const code of locales.codes) {
		if (code === "en") continue;
		const other = await catalogue(code);
		expect(english.filter((k) => !other.includes(k))).toEqual([]);
		expect(other.filter((k) => !english.includes(k))).toEqual([]);
	}
});

test("every error code this app can answer with has a sentence", async () => {
	const { ERROR_CODES } = await import("./src/errors");
	const en = (await Bun.file(`${HERE}messages/en.json`).json()) as {
		errors: Record<string, string>;
	};
	for (const code of ERROR_CODES) expect(en.errors[code]).toBeString();
});

/** The codes a tree of source answers with: `{ code: "x" }` and `refuse(c, status, "x")`. */
async function emittedCodes(...roots: string[]): Promise<string[]> {
	const codes = new Set<string>();
	for (const root of roots)
		for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
			if (/\.test\.tsx?$/.test(file) || file.includes("testing/")) continue;
			const source = await Bun.file(`${root}/${file}`).text();
			for (const [, code] of source.matchAll(
				/(?:\bcode: |refuse\(c, \d+, )"([a-z_.]+)"/g,
			))
				if (code) codes.add(code);
		}
	return [...codes].sort();
}

test("every code the backend's routes or this app's own answer with is read as a code that has a sentence", async () => {
	const { ERROR_CODES, SAME_AS, errorCodeOf } = await import("./src/errors");
	const emitted = await emittedCodes(
		`${HERE}app/api`,
		`${HERE}server`,
		`${HERE}../backend/src/routes`,
		`${HERE}../backend/src/product`,
		`${HERE}../backend/src/auth`,
	);
	expect(emitted.length).toBeGreaterThan(10);
	// A voice refusal's code is folded with its reason, and a turn's refusal is read where the turn is sent.
	const elsewhere = new Set(["refused", "thread.busy", "turn.invalid"]);
	const known = new Set<string>(ERROR_CODES);
	// The product's folder also declares its languages, each under a `code` of its own.
	const languages = new Set<string>(productLocales.codes);
	const unread = emitted.filter(
		(code) =>
			!known.has(code) &&
			!(code in SAME_AS) &&
			!elsewhere.has(code) &&
			!languages.has(code),
	);
	expect(unread).toEqual([]);
	expect(errorCodeOf({ code: "invalid_query" }, 400)).toBe("bad_request");
	expect(errorCodeOf({ code: "erase_incomplete" }, 500)).toBe(
		"erase_incomplete",
	);
});
