/**
 * The image's frozen install resolves the whole workspace set against
 * bun.lock, so the Dockerfile must copy every workspace's manifest: one
 * missing is "lockfile had changes, but lockfile is frozen" in the remote
 * build, after the upload. A directory copied whole carries its manifests.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

test("the Dockerfile copies every workspace manifest bun.lock records", () => {
	const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
	const workspaces = [
		...lock.matchAll(/^ {4}"((?:apps|platform)\/[^"]+)": \{/gm),
	].map((m) => m[1] as string);
	const copies = [
		...readFileSync(
			join(ROOT, "apps", "backend", "Dockerfile"),
			"utf8",
		).matchAll(/^COPY (\S+?)(?:\/package\.json)? \S+$/gm),
	].map((m) => m[1] as string);
	const missing = workspaces.filter(
		(dir) => !copies.some((src) => dir === src || dir.startsWith(`${src}/`)),
	);
	expect(workspaces.length).toBeGreaterThan(0);
	expect(missing).toEqual([]);
});

/**
 * The migrate job runs this image and loads the sample library from it, so
 * the directory has to reach the runtime stage: copied with the app, and
 * excluded by no `.dockerignore` pattern. A pattern there matches from the
 * context root, `**` crossing directories, and excludes everything under a
 * directory it matches.
 */
test("the image carries the sample library", async () => {
	const dockerfile = readFileSync(
		join(ROOT, "apps", "backend", "Dockerfile"),
		"utf8",
	);
	expect(dockerfile).toContain("\nCOPY apps/backend ./apps/backend\n");
	expect(dockerfile).toContain(
		"\nCOPY --from=deps --chown=bun:bun /repo/apps/backend /repo/apps/backend\n",
	);
	const patterns = readFileSync(join(ROOT, ".dockerignore"), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
	const library = "apps/backend/sample/library";
	const files: string[] = [];
	for await (const rel of new Bun.Glob("**/*").scan({
		cwd: join(ROOT, library),
	}))
		files.push(`${library}/${rel}`);
	expect(files.some((f) => f.endsWith(".md"))).toBe(true);
	expect(files.some((f) => f.endsWith(".png"))).toBe(true);
	const excluded = files.filter((file) => {
		const segments = file.split("/");
		const paths = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
		return patterns.some((pattern) =>
			paths.some((path) => new Bun.Glob(pattern).match(path)),
		);
	});
	expect(excluded).toEqual([]);
});
