import { expect, test } from "bun:test";
import en from "../../messages/en.json";
import it from "../../messages/it.json";

/**
 * The privacy notice's storage paragraph names every key this app writes to
 * the browser's own storage: "no cookie banner" holds only while each one is
 * strictly necessary or a choice the person made, and a key nobody was told
 * about is a claim the notice no longer keeps. The keys are read off the
 * source — a literal, or the constant the call names.
 */
const root = new URL("../../", import.meta.url).pathname;
const CALL =
	/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))/g;

async function storageKeys(): Promise<Set<string>> {
	const keys = new Set<string>();
	for (const dir of ["app", "src"]) {
		for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(
			`${root}${dir}`,
		)) {
			if (/\.test\.tsx?$/.test(file)) continue;
			const source = await Bun.file(`${root}${dir}/${file}`).text();
			for (const [, double, single, name] of source.matchAll(CALL)) {
				const key =
					double ??
					single ??
					source.match(
						new RegExp(`const ${name}\\s*=\\s*["']([^"']+)["']`),
					)?.[1];
				if (!key)
					throw new Error(`${dir}/${file}: cannot read the key ${name}`);
				keys.add(key);
			}
		}
	}
	return keys;
}

test("the notice names every key the app keeps in browser storage", async () => {
	const keys = await storageKeys();
	expect(keys.size).toBeGreaterThan(0);
	for (const key of keys) {
		expect(en.privacy.cookies.body).toContain(key);
		expect(it.privacy.cookies.body).toContain(key);
	}
});
