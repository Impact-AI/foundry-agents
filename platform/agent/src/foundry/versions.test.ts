import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { configure } from "@platform/llm/testing";
import { scopedEnv } from "@platform/test-support";
import { agentKeys } from "../keys";
import { createAgentVersion, resetFoundryClients } from "./client";
import { definitionHash } from "./definition";
import {
	FAKE_FOUNDRY_ENDPOINT,
	type FakeFoundry,
	fakeFoundry,
} from "./testing/fake-foundry";
import { agentVersions, pruneVersions } from "./versions";

/**
 * Finding a definition's version when the service's listing trails the
 * versions just made: the job makes one without the fleet's memo, and a
 * backend starting a moment later must find it rather than make it again.
 * Each `agentVersions` here is a process of its own, under its own keys,
 * so nothing is shared but the service.
 */

const NAME = "sample";
const definition = (instructions: string) => ({
	kind: "prompt" as const,
	model: "chat",
	instructions,
});

let fake: FakeFoundry;
const restores: (() => void)[] = [];
const process = (who: string) =>
	agentVersions<ReturnType<typeof definition>>(
		NAME,
		agentKeys(`versions-${who}-${crypto.randomUUID().slice(0, 8)}`),
		"prompt",
	);
const held = () => (fake.state.agents.get(NAME) ?? []).map((v) => v.version);

beforeAll(() => {
	restores.push(
		scopedEnv({ FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT }),
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
		}),
		resetFoundryClients,
	);
	resetFoundryClients();
});

beforeEach(() => {
	fake = fakeFoundry();
	restores.push(fake.install());
});

afterAll(() => {
	for (const restore of restores.reverse()) restore();
});

test("a version the listing does not show yet is found by its number, not made again", async () => {
	fake.state.listingLag = 2;
	expect(await process("job").ensure(definition("one"))).toBe("1");
	expect(await process("backend").ensure(definition("one"))).toBe("1");
	expect(await process("job").ensure(definition("two"))).toBe("2");
	// Neither version is listed: both are read by number, past the newest listed (none).
	expect(await process("replica").ensure(definition("two"))).toBe("2");
	expect(await process("replica").ensure(definition("one"))).toBe("1");
	expect(held()).toEqual(["1", "2"]);
});

test("past a listed version, the numbers after it are read up to the first that is not there", async () => {
	for (const words of ["a", "b", "c"])
		await process("job").ensure(definition(words));
	fake.state.listingLag = 1;
	expect(await process("backend").ensure(definition("c"))).toBe("3");
	expect(await process("backend").ensure(definition("d"))).toBe("4");
	expect(held()).toEqual(["1", "2", "3", "4"]);
});

test("a second version of one definition is harmless: either is the same definition, and nothing more is made", async () => {
	const same = definition("same");
	expect(await process("job").ensure(same)).toBe("1");
	// What two processes that each missed the other's would leave.
	await createAgentVersion(NAME, same, { hash: definitionHash(same) });
	expect(await process("backend").ensure(same)).toBe("2");
	// Listed only up to the older one, it is found: the same words, the same tools.
	fake.state.listingLag = 1;
	expect(await process("replica").ensure(same)).toBe("1");
	expect(held()).toEqual(["1", "2"]);
});

test("the prune deletes only listed versions past the newest kept and the pinned: one the listing trails survives it", async () => {
	for (const words of ["a", "b", "c", "d", "e"])
		await process("job").ensure(definition(words));
	fake.state.listingLag = 1;
	// Listed: 4, 3, 2, 1. Keep the newest two listed and pin 1; 5 is not listed and so not touched.
	expect(await pruneVersions(NAME, 2, "prompt", ["1"])).toBe(1);
	expect(held()).toEqual(["1", "3", "4", "5"]);
	fake.state.listingLag = 0;
	expect(await process("backend").ensure(definition("e"))).toBe("5");
});

test("the prune keeps a version a live session is marked as running on, however old", async () => {
	for (const words of ["f", "g", "h", "i"])
		await process("job").ensure(definition(words));
	const before = held();
	const oldest = before[0] as string;
	const asked: string[] = [];
	const deleted = await pruneVersions(
		NAME,
		1,
		"prompt",
		[],
		async (version) => {
			asked.push(version);
			return version === oldest;
		},
	);
	expect(deleted).toBe(before.length - 2);
	expect(held()).toEqual([oldest, before.at(-1) as string]);
	// The newest kept is never asked about.
	expect(asked).not.toContain(before.at(-1));
});
