/**
 * azd's remote build packs the repository root as the build context and
 * fails on a symlink ("archive/tar: write too long"): it writes the header
 * from the link and the body from the target. Every tracked symlink outside
 * node_modules must therefore be excluded by the root .dockerignore.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;

test("no tracked symlink reaches the remote build context", () => {
	const index = Bun.spawnSync(["git", "ls-files", "-s"], { cwd: ROOT });
	// The index that could not be read holds no link to find: that is a
	// failure to look, not a pass.
	expect(index.exitCode).toBe(0);
	expect(index.stdout.length).toBeGreaterThan(0);
	const links = new TextDecoder()
		.decode(index.stdout)
		.split("\n")
		.filter((line) => line.startsWith("120000 "))
		.map((line) => line.split("\t")[1] ?? "")
		.filter((path) => !path.includes("node_modules/"));
	const ignored = readFileSync(join(ROOT, ".dockerignore"), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	const reaching = links.filter(
		(path) =>
			!ignored.some(
				(pattern) => path === pattern || path.startsWith(`${pattern}/`),
			),
	);
	expect(reaching).toEqual([]);
});
