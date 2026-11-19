import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { type CosmosDatabase, setCosmosDatabase } from "@platform/cosmos";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { promptContainers } from "./prompt-slot";
import { defineSkills, type SkillDefault } from "./skill-store";

/** On a database of its own: in memory, or the emulator under `COSMOS_TESTS=1`. Each test names skills of its own. */
let cosmos: TestCosmos;

beforeAll(async () => {
	cosmos = await openTestCosmos(promptContainers);
});

afterAll(async () => {
	await cosmos.drop();
});

const skill = (
	name: string,
	more: Partial<SkillDefault> = {},
): SkillDefault => ({
	name,
	description: `Use when ${name} is asked.`,
	instructions: `Do ${name}.`,
	...more,
});

test("the job seeds a default whose name has no version, and never writes over one that has", async () => {
	const finder = skill("seed-finder", { requiresTools: ["shelf"] });
	const shipped = defineSkills([finder]);
	expect(await shipped.seed()).toEqual(["seed-finder"]);
	expect(await shipped.seed()).toEqual([]);
	// The operator's version, then a deploy whose code changed the default: the operator's stands.
	await shipped.publish(
		"seed-finder",
		{
			description: "Use when a book is lost.",
			instructions: "Ask the desk.",
			surfaces: [],
			requiresTools: ["shelf"],
			enabled: true,
		},
		{ activate: true },
	);
	const changed = defineSkills([{ ...finder, instructions: "Look harder." }]);
	expect(await changed.seed()).toEqual([]);
	expect(
		(await changed.list()).find((s) => s.name === "seed-finder"),
	).toMatchObject({
		label: "v2",
		origin: "custom",
		instructions: "Ask the desk.",
	});
	// Reset is the one way the code's words come back.
	expect(await changed.reset("seed-finder")).toBe("v3");
	expect(
		(await changed.list()).find((s) => s.name === "seed-finder"),
	).toMatchObject({
		label: "v3",
		origin: "shipped",
		instructions: "Look harder.",
	});
});

test("a turn reads the active, enabled versions; a version not activated, or switched off, is not served", async () => {
	const store = defineSkills([]);
	await store.publish("read-on", {
		description: "Use when reading.",
		instructions: "Read.",
		surfaces: ["web"],
		requiresTools: [],
		enabled: true,
	});
	await store.publish(
		"read-on",
		{
			description: "Use when reading, newly.",
			instructions: "Read again.",
			surfaces: [],
			requiresTools: [],
			enabled: true,
		},
		{ activate: false },
	);
	await store.publish("read-off", {
		description: "Use never.",
		instructions: "Nothing.",
		surfaces: [],
		requiresTools: [],
		enabled: false,
	});
	store.invalidate();
	const served = await store.read();
	expect(served.find((s) => s.name === "read-on")).toEqual({
		name: "read-on",
		description: "Use when reading.",
		instructions: "Read.",
		surfaces: ["web"],
		requiresTools: [],
	});
	expect(served.some((s) => s.name === "read-off")).toBe(false);
	expect(await store.activate("read-on", "v2")).toBe(true);
	expect(await store.activate("read-on", "v9")).toBe(false);
	expect(
		(await store.read()).find((s) => s.name === "read-on")?.instructions,
	).toBe("Read again.");
});

test("while the database cannot be read, the product's defaults are served", async () => {
	const fallback = skill("fallback-only");
	const store = defineSkills([fallback]);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	setCosmosDatabase({
		container() {
			throw new Error("the database is down");
		},
	} as unknown as CosmosDatabase);
	try {
		expect(await store.read()).toEqual([fallback]);
	} finally {
		setCosmosDatabase(cosmos.database);
		warn.mockRestore();
	}
});

test("a name the model could not read a skill by is refused", async () => {
	await expect(
		defineSkills([]).publish("Not a name", {
			description: "x",
			instructions: "y",
			surfaces: [],
			requiresTools: [],
			enabled: true,
		}),
	).rejects.toThrow("is not a skill name");
});
