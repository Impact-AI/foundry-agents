/**
 * The image's build stage holds `platform` and this app, plus the files it
 * names one by one. A source file reaching outside both for something it
 * compiles — the product's language list, today — builds on a laptop and
 * fails in the remote build with "Module not found", after the upload. So
 * every such file, and whatever it reaches in turn, must be a COPY of its own.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const APP = join(ROOT, "apps", "frontend");
const SKIP = /(?:^|\/)(?:node_modules|\.next[^/]*|e2e)(?:\/|$)|\.test\.tsx?$/;
const RELATIVE = /(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Source files only: a package reached by path is the install's, not build input. */
function relativeImports(file: string): string[] {
	return [...readFileSync(file, "utf8").matchAll(RELATIVE)].flatMap((m) => {
		const target = resolve(dirname(file), m[1] as string);
		if (target.includes("/node_modules/")) return [];
		const found = EXTENSIONS.map((ext) => `${target}${ext}`).find(
			(path) => /\.(tsx?|json|css)$/.test(path) && existsSync(path),
		);
		return found ? [found] : [];
	});
}

const outside = (file: string) =>
	!file.startsWith(`${APP}/`) && !file.startsWith(join(ROOT, "platform/"));

test("every file the app compiles from outside its own tree and `platform` is copied into the image", async () => {
	const reached = new Set<string>();
	const pending: string[] = [];
	for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: APP }))
		if (!SKIP.test(rel)) pending.push(...relativeImports(join(APP, rel)));
	while (pending.length) {
		const file = pending.pop() as string;
		if (!outside(file) || reached.has(file)) continue;
		reached.add(file);
		if (/\.tsx?$/.test(file)) pending.push(...relativeImports(file));
	}
	const dockerfile = readFileSync(join(APP, "Dockerfile"), "utf8");
	const files = [...reached].map((file) => relative(ROOT, file));
	expect(files).toContain("apps/backend/src/product/locales.ts");
	for (const file of files)
		expect(dockerfile).toContain(`\nCOPY ${file} ./${file}\n`);
});
