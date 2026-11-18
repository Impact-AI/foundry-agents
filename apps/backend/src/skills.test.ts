import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { defineSkills, promptContainers } from "@platform/prompt/store";
import { skillsCli } from "./skills";

/** The CLI over a store with one shipped default, on a database of its own. */
const store = defineSkills([
	{
		name: "shelf-finder",
		description: "Use when a book is lost.",
		instructions: "Call `shelf` first.",
		requiresTools: ["shelf"],
	},
]);
const run = (...args: string[]) => skillsCli(args, store);

let cosmos: TestCosmos;
let file: string;

beforeAll(async () => {
	cosmos = await openTestCosmos(promptContainers);
	file = join(process.env.TMPDIR ?? "/tmp", `skill-${crypto.randomUUID()}.md`);
	await Bun.write(
		file,
		"---\nname: house-rules\ndescription: Use when asked about the rules.\n---\n\nQuote them.",
	);
});

afterAll(async () => {
	await Bun.file(file).delete();
	await cosmos.drop();
});

test("an operator publishes a skill from a SKILL.md, activates a version, switches it off and on, and lists the store", async () => {
	expect(await run("list")).toBe(
		"there are no skills stored: the product's defaults are served",
	);
	expect(await run("publish", "house-rules", file, "--surfaces", "web")).toBe(
		'"house-rules" v1 published, the active version',
	);
	expect(
		await run("publish", "house-rules", file, "--requires-tools", "rules"),
	).toBe('"house-rules" v2 published; v1 is still active');
	expect(await run("activate", "house-rules", "v2")).toBe(
		'"house-rules" v2 is the active version',
	);
	expect(await run("disable", "house-rules")).toBe(
		'"house-rules" v3, disabled, is the active version',
	);
	expect(await run("disable", "house-rules")).toBe(
		'"house-rules" is already disabled',
	);
	expect(await run("list")).toBe(
		"house-rules v3: custom, disabled, surfaces all, tools rules",
	);
	store.invalidate();
	expect(await store.read()).toEqual([]);
	expect(await run("enable", "house-rules")).toBe(
		'"house-rules" v4, enabled, is the active version',
	);
	expect((await store.read()).map((skill) => skill.name)).toEqual([
		"house-rules",
	]);
	await expect(run("activate", "house-rules", "v9")).rejects.toThrow(
		'has no version "v9"',
	);
});

test("reset publishes the product's default as the active version, and only a shipped skill is reset", async () => {
	expect(await run("reset", "shelf-finder")).toBe(
		'"shelf-finder" v1, the product\'s default, is the active version',
	);
	expect(await run("list")).toContain(
		"shelf-finder v1: shipped, enabled, surfaces all, tools shelf",
	);
	await expect(run("reset", "house-rules")).rejects.toThrow(
		"only a shipped skill is reset",
	);
});

test("a file that names another skill, and a command it does not know, are refused", async () => {
	await expect(run("publish", "shelf-finder", file)).rejects.toThrow(
		'names the skill "house-rules"',
	);
	await expect(run("enable")).rejects.toThrow(/usage/);
	await expect(run("list", "--activate")).rejects.toThrow(/usage/);
	await expect(run()).rejects.toThrow(/usage/);
});
