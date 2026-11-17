import { expect, test } from "bun:test";

/**
 * The signed-in shell's layout draws the one <main> every page under it
 * shares; a page that draws its own nests a second main landmark inside the
 * first.
 */
const here = new URL("./", import.meta.url).pathname;
const glob = new Bun.Glob("**/*.tsx");

test("the shell draws the one <main>; no page under it draws another", async () => {
	const layout = await Bun.file(`${here}layout.tsx`).text();
	expect(layout.match(/<main\b/g)).toHaveLength(1);
	const nested: string[] = [];
	for await (const file of glob.scan(here)) {
		if (file === "layout.tsx") continue;
		if (/<main\b/.test(await Bun.file(`${here}${file}`).text()))
			nested.push(file);
	}
	expect(nested).toEqual([]);
});
