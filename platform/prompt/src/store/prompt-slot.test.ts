import { afterAll, beforeAll, expect, test } from "bun:test";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { definePrompt, promptContainers } from "./prompt-slot";

/** On a database of its own: in memory, or the emulator under `COSMOS_TESTS=1`. */
let cosmos: TestCosmos;

beforeAll(async () => {
	cosmos = await openTestCosmos(promptContainers);
});

afterAll(async () => {
	await cosmos.drop();
});

const slotFor = (key: string, defaultText = "You are a helpful guide.") =>
	definePrompt({ key, title: "Persona", defaultText });

/** The latest version is the one written last by `createdAt`, at millisecond resolution: deploys are minutes apart, this test is not. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

test("a prompt slot serves the default until seeded, then the active version, and names what it serves", async () => {
	const slot = slotFor("persona");
	expect(await slot.read()).toBe("You are a helpful guide.");
	expect(await slot.version()).toBeNull();
	expect(await slot.seed()).toBe(true);
	expect(await slot.seed()).toBe(false);
	slot.invalidate();
	expect(await slot.read()).toBe("You are a helpful guide.");
	expect(await slot.version()).toEqual({ label: "v1", chars: 24 });
	const v1 = await slot.named("v1");
	expect(v1).toMatchObject({ label: "v1", isActive: true });
	expect(await slot.named("v9")).toBeNull();
	expect(await slot.named("a/b")).toBeNull();
});

test("a published version becomes the one active version, an older one can be made active again, and a label is used once", async () => {
	const slot = slotFor("published");
	// A key with no version yet is seeded first, so the switch has something to switch off.
	await slot.publish({ label: "v2", text: "You are terse." });
	expect(await slot.read()).toBe("You are terse.");
	expect(await slot.version()).toEqual({ label: "v2", chars: 14 });
	expect(await slot.named("v1")).toMatchObject({ isActive: false });

	await expect(
		slot.publish({ label: "v2", text: "Something else." }),
	).rejects.toThrow(/has a version "v2" already/);
	await expect(slot.publish({ label: "a/b", text: "x" })).rejects.toThrow(
		/not a label/,
	);
	expect(await slot.read()).toBe("You are terse.");

	expect(await slot.activate("v1")).toBe(true);
	expect(await slot.read()).toBe("You are a helpful guide.");
	expect(await slot.named("v2")).toMatchObject({ isActive: false });
	expect(await slot.activate("v1")).toBe(true);
	expect(await slot.activate("v7")).toBe(false);
	expect(await slot.version()).toEqual({ label: "v1", chars: 24 });
});

test("sync seeds a fresh key, leaves a seed that matches alone, publishes the shipped text over a seed it moved past, and never over an operator's version", async () => {
	const slot = slotFor("synced");
	expect(await slot.sync()).toEqual({ outcome: "seeded", label: "v1" });
	expect(await slot.sync()).toEqual({ outcome: "unchanged", label: "v1" });
	expect(await slot.read()).toBe("You are a helpful guide.");

	// The code's text changed between deploys: the next version is the code's too.
	await tick();
	const changed = slotFor("synced", "You are a patient guide.");
	expect(await changed.sync()).toEqual({ outcome: "published", label: "v2" });
	expect(await changed.read()).toBe("You are a patient guide.");
	expect(await changed.named("v1")).toMatchObject({ isActive: false });
	expect(await changed.sync()).toEqual({ outcome: "unchanged", label: "v2" });

	// An operator's version ends it: the shipped text is the fallback and nothing more.
	await tick();
	await changed.publish({ label: "mine", text: "You are terse." });
	const later = slotFor("synced", "You are a kind guide.");
	expect(await later.sync()).toEqual({
		outcome: "operator",
		label: "mine",
		defaultChanged: true,
	});
	expect(await later.read()).toBe("You are terse.");
	expect(await later.named("v3")).toBeNull();
	// The operator put the seed back: the latest is still theirs, and it stays.
	expect(await later.activate("v1")).toBe(true);
	expect(await later.sync()).toMatchObject({
		outcome: "operator",
		label: "mine",
	});
	expect(await later.read()).toBe("You are a helpful guide.");
});

test("a v1 written before versions carried their source is the seed, and the shipped text moves past it", async () => {
	// As the first deploys wrote the seed: the default text, no mark.
	await cosmos.database.container("prompts").create({
		id: "v1",
		key: "legacy",
		title: "Persona",
		prompt: "You are a helpful guide.",
		label: "v1",
		isActive: true,
		createdAt: new Date().toISOString(),
	});
	expect(await slotFor("legacy").sync()).toEqual({
		outcome: "unchanged",
		label: "v1",
	});
	expect(await slotFor("legacy", "Changed.").sync()).toEqual({
		outcome: "published",
		label: "v2",
	});
	expect(await slotFor("legacy", "Changed.").read()).toBe("Changed.");
});

test("two publishes at once: one wins, the other is refused, and exactly one version is active", async () => {
	const slot = slotFor("raced");
	await slot.seed();
	const outcomes = await Promise.allSettled([
		slot.publish({ label: "a", text: "First." }),
		slot.publish({ label: "b", text: "Second." }),
	]);
	expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
	const states = await Promise.all(
		["v1", "a", "b"].map((label) => slot.named(label)),
	);
	expect(states.filter((s) => s?.isActive)).toHaveLength(1);
});
