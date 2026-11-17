import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { promptContainers } from "@platform/prompt/store";
import { persona } from "./persona";
import { prompt } from "./product";

let cosmos: TestCosmos;
let draft: string;

beforeAll(async () => {
	cosmos = await openTestCosmos(promptContainers);
	draft = join(
		process.env.TMPDIR ?? "/tmp",
		`persona-${crypto.randomUUID()}.md`,
	);
	await Bun.write(draft, "# CORE IDENTITY\nYou are brief.");
});

afterAll(async () => {
	await Bun.file(draft).delete();
	await cosmos.drop();
});

test("an operator publishes a version from a file, goes back to the first, and is told which is active", async () => {
	expect(await persona(["show"])).toBe(
		"the persona has no version: the code's default is served",
	);
	expect(await persona(["publish", "v2", draft])).toBe(
		`the persona's active version is "v2", 30 characters`,
	);
	expect(await prompt.read()).toBe("# CORE IDENTITY\nYou are brief.");
	expect(await persona(["activate", "v1"])).toMatch(/active version is "v1"/);
	await expect(persona(["activate", "v9"])).rejects.toThrow(
		'the persona has no version "v9"',
	);
	await expect(persona(["publish", "v3"])).rejects.toThrow(/usage/);
	await expect(persona([])).rejects.toThrow(/usage/);
});
