import { afterAll, beforeAll, expect, type Mock, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SkillSource } from "@platform/agent";
import {
	FAKE_FOUNDRY_ENDPOINT,
	type FakeFoundry,
	fakeFoundry,
} from "@platform/agent/testing";
import { configure } from "@platform/llm/testing";
import { scopedEnv } from "@platform/test-support";
import { skills } from "./skills";

const CATALOGUE: SkillSource[] = [
	{
		name: "shelf-finder",
		description: "Use when a book is lost.",
		instructions: "Call `shelf` first.",
		requiresTools: ["shelf"],
	},
];

let fake: FakeFoundry;
let folder: string;
let warn: Mock<typeof console.warn>;
const restores: (() => void)[] = [];
const run = (...args: string[]) => skills(args, CATALOGUE);

beforeAll(async () => {
	restores.push(
		scopedEnv({ FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT }),
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
		}),
	);
	fake = fakeFoundry();
	restores.push(fake.install());
	warn = spyOn(console, "warn").mockImplementation(() => {});
	restores.push(() => warn.mockRestore());
	folder = join(
		process.env.TMPDIR ?? "/tmp",
		`skills-${crypto.randomUUID()}`,
		"house-rules",
	);
	await mkdir(folder, { recursive: true });
	await Bun.write(
		join(folder, "SKILL.md"),
		[
			"---",
			"name: house-rules",
			"description: Use when asked about the rules.",
			"metadata:",
			"  surfaces: web",
			"---",
			"",
			"Quote them.",
		].join("\n"),
	);
});

afterAll(async () => {
	for (const restore of restores.reverse()) restore();
	await rm(join(folder, ".."), { recursive: true, force: true });
});

test("an operator publishes a skill from a folder, makes it the default, switches it off and back, and lists the project", async () => {
	expect(await run("list")).toBe("the project has no skills");
	expect(
		await run("publish", "house-rules", folder, "--requires-tools", "rules"),
	).toBe('"house-rules" v1 published');
	expect(await run("publish", "house-rules", folder, "--default")).toBe(
		'"house-rules" v2 published, the default',
	);
	expect(fake.state.skills.get("house-rules")?.versions[1]?.metadata).toEqual({
		origin: "custom",
		enabled: "true",
		surfaces: "web",
	});
	expect(await run("disable", "house-rules")).toBe(
		'"house-rules" v3, disabled, is the default',
	);
	expect(await run("disable", "house-rules")).toBe(
		'"house-rules" v3 is already disabled',
	);
	expect(await run("enable", "house-rules")).toBe(
		'"house-rules" v4, enabled, is the default',
	);
	expect(await run("default", "house-rules", "1")).toBe(
		'"house-rules" v1 is the default',
	);
	expect(await run("list")).toBe(
		"house-rules v1: custom, enabled, surfaces web, tools rules",
	);
});

test("reset makes the code's default the default again, and only a skill the code ships is reset", async () => {
	await expect(
		run("publish", "shelf-finder", join(folder, "SKILL.md")),
	).rejects.toThrow('names the skill "house-rules"');
	expect(await run("reset", "shelf-finder")).toBe(
		'"shelf-finder" v1, the code\'s default, is the default',
	);
	expect(await run("list")).toContain(
		"shelf-finder v1: shipped, enabled, surfaces all, tools shelf",
	);
	await expect(run("reset", "house-rules")).rejects.toThrow(
		"the code has no default",
	);
});

test("a folder with files beside its SKILL.md, and a command it does not know, are refused", async () => {
	await Bun.write(join(folder, "notes.txt"), "more");
	await expect(run("publish", "house-rules", folder)).rejects.toThrow(
		"upload a bundled skill in the portal",
	);
	await expect(run("enable")).rejects.toThrow(/usage/);
	await expect(run("list", "--default")).rejects.toThrow(/usage/);
	await expect(run()).rejects.toThrow(/usage/);
});
