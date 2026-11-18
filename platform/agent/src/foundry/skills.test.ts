import {
	afterAll,
	beforeAll,
	beforeEach,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { configure } from "@platform/llm/testing";
import { scopedEnv } from "@platform/test-support";
import type { SkillSource } from "../contract/product";
import { resetFoundryClients } from "./client";
import {
	fittingSkills,
	forgetSkills,
	publishSkills,
	publishSkillVersion,
	readSkillFile,
	readSkillVersion,
	setDefaultSkillVersion,
	skillMeta,
} from "./skills";
import {
	FAKE_FOUNDRY_ENDPOINT,
	type FakeFoundry,
	fakeFoundry,
} from "./testing/fake-foundry";

/**
 * Skills managed in the project: the catalogue in code seeds them and never
 * overwrites an operator's, and a turn carries what the project holds,
 * gated by each default version's metadata.
 */

const CATALOGUE: SkillSource[] = [
	{
		name: "shelf-finder",
		description: "Use when a book is lost.",
		instructions: "Call `shelf` first.",
		requiresTools: ["shelf"],
	},
	{
		name: "voice-only",
		description: "Use when speaking.",
		instructions: "Speak briefly.",
		surfaces: ["voice"],
	},
];
const WEB = { surface: "web", enabledTools: ["shelf"] };

let fake: FakeFoundry;
let warn: Mock<typeof console.warn>;
const restores: (() => void)[] = [];
const defaultOf = (name: string) =>
	fake.state.skills.get(name)?.default_version;

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
	warn = spyOn(console, "warn").mockImplementation(() => {});
	restores.push(() => warn.mockRestore());
});

beforeEach(() => {
	warn.mockClear();
	fake = fakeFoundry();
	restores.push(fake.install());
});

afterAll(() => {
	for (const restore of restores.reverse()) restore();
});

test("a deploy seeds what is missing, leaves its own unchanged words alone, and updates its own changed ones", async () => {
	expect(await publishSkills(CATALOGUE)).toEqual({
		"shelf-finder": "published",
		"voice-only": "published",
	});
	expect(await publishSkills(CATALOGUE)).toEqual({
		"shelf-finder": "unchanged",
		"voice-only": "unchanged",
	});
	const [first, second] = CATALOGUE as [SkillSource, SkillSource];
	expect(
		await publishSkills([
			{ ...first, instructions: "Call `shelf`, then look." },
			{ ...second, surfaces: ["voice", "web"] },
		]),
	).toEqual({ "shelf-finder": "published", "voice-only": "published" });
	expect(defaultOf("shelf-finder")).toBe("2");
	expect(defaultOf("voice-only")).toBe("2");
	const shipped = fake.state.skills.get("shelf-finder")?.versions.at(-1);
	expect(shipped?.metadata).toEqual({
		origin: "shipped",
		"content-hash": expect.stringMatching(/^[0-9a-f]{24}$/),
		enabled: "true",
		"requires-tools": "shelf",
	});
});

test("a deploy never overwrites the operator's default, nor touches a skill the catalogue does not name", async () => {
	await publishSkills(CATALOGUE);
	await publishSkillVersion(
		"shelf-finder",
		{
			description: "Use when a book is lost.",
			instructions: "Ask the desk.",
			meta: skillMeta({ origin: "custom" }),
		},
		true,
	);
	await publishSkillVersion(
		"house-rules",
		{
			description: "Use when asked about the rules.",
			instructions: "Quote them.",
			meta: skillMeta({}),
		},
		true,
	);
	const [first, second] = CATALOGUE as [SkillSource, SkillSource];
	expect(
		await publishSkills([
			{ ...first, instructions: "Call `shelf`, then look." },
			second,
		]),
	).toEqual({ "shelf-finder": "kept", "voice-only": "unchanged" });
	expect(defaultOf("shelf-finder")).toBe("2");
	expect(fake.state.skills.get("house-rules")?.versions).toHaveLength(1);

	// A shipped version made the default again is the job's once more: the next deploy brings it up to the code.
	await setDefaultSkillVersion("shelf-finder", "1");
	expect(
		await publishSkills([
			{ ...first, instructions: "Call `shelf`, then look." },
		]),
	).toEqual({ "shelf-finder": "published" });
	expect(defaultOf("shelf-finder")).toBe("3");
});

test("a version with no origin is not the job's: one published before origins were written is kept", async () => {
	await publishSkillVersion(
		"shelf-finder",
		{
			description: "Use when a book is lost.",
			instructions: "Call `shelf` first.",
			meta: { ...skillMeta({}), hash: "an-older-hash" },
		},
		true,
	);
	expect(await publishSkills(CATALOGUE.slice(0, 1))).toEqual({
		"shelf-finder": "kept",
	});
});

test("a turn carries every enabled skill in the project that fits it, a portal skill with no metadata among them", async () => {
	await publishSkills(CATALOGUE);
	await publishSkillVersion(
		"house-rules",
		{
			description: "Use when asked about the rules.",
			instructions: "Quote them.",
			meta: skillMeta({}),
		},
		true,
	);
	// What a portal upload with no metadata is: a version whose front matter says nothing about gating.
	const portal = fake.state.skills.get("house-rules")?.versions[0];
	if (portal) portal.metadata = {};
	await publishSkillVersion(
		"retired",
		{
			description: "Use never.",
			instructions: "Nothing.",
			meta: skillMeta({ enabled: "false", origin: "custom" }),
		},
		true,
	);
	forgetSkills();
	const names = async (turn = WEB, enabled = true) =>
		(await fittingSkills([], turn, enabled)).map(
			({ name, version }) => `${name}@${version}`,
		);
	expect(await names()).toEqual(["house-rules@1", "shelf-finder@1"]);
	expect(await names({ surface: "voice", enabledTools: [] })).toEqual([
		"house-rules@1",
		"voice-only@1",
	]);
	expect(await names(WEB, false)).toEqual([]);
	expect(
		(await fittingSkills([], WEB, true)).find((s) => s.name === "house-rules")
			?.description,
	).toBe("Use when asked about the rules.");
	expect(await readSkillVersion({ name: "shelf-finder", version: "1" })).toBe(
		"Call `shelf` first.",
	);
});

test("an operator's new default reaches the next listing, and a version's folder is read once", async () => {
	await publishSkills(CATALOGUE);
	await fittingSkills([], WEB, true);
	const reads = () =>
		fake.requests.filter((r) => r.endsWith("/content")).length;
	const before = reads();
	forgetSkills();
	await fittingSkills([], WEB, true);
	await fittingSkills([], WEB, true);
	// Forgetting cleared the folders too; the memo holds the second ask.
	expect(reads() - before).toBe(2);
	await publishSkillVersion(
		"shelf-finder",
		{
			description: "Use when a book is lost.",
			instructions: "Ask the desk.",
			meta: skillMeta({ origin: "custom", "requires-tools": "shelf" }),
		},
		true,
	);
	expect(
		(await fittingSkills([], WEB, true)).map((s) => `${s.name}@${s.version}`),
	).toEqual(["shelf-finder@2"]);
});

test("when the project's skills cannot be listed, a turn carries the catalogue in code at each skill's default version", async () => {
	await publishSkills(CATALOGUE.slice(0, 1));
	forgetSkills();
	fake.failWhen((method, path) => method === "GET" && path === "/skills", 403);
	try {
		const fitting = await fittingSkills(CATALOGUE, WEB, true);
		expect(fitting).toEqual([
			{
				name: "shelf-finder",
				version: "1",
				description: "Use when a book is lost.",
				surfaces: [],
				requiresTools: ["shelf"],
				enabled: true,
			},
		]);
		expect(warn.mock.calls.flat().join("\n")).toContain(
			"the catalogue in code is offered",
		);
	} finally {
		fake.failWhen(null);
	}
});

test("a SKILL.md's front matter is read as the service writes it and as an operator would", () => {
	expect(
		readSkillFile(
			[
				"---",
				"name: shelf-finder",
				'description: "Use when: a book is lost."',
				"metadata:",
				"  origin: custom",
				"  surfaces: 'web, voice'",
				"license: MIT",
				"---",
				"",
				"Call `shelf` first.",
			].join("\n"),
		),
	).toEqual({
		name: "shelf-finder",
		description: "Use when: a book is lost.",
		metadata: { origin: "custom", surfaces: "web, voice" },
		body: "Call `shelf` first.",
	});
	const flow = readSkillFile(
		'---\nname: x\nmetadata: {"enabled": "false", requires-tools: shelf}\n---\nBody.',
	);
	expect(skillMeta(flow.metadata)).toEqual({
		surfaces: [],
		requiresTools: ["shelf"],
		enabled: false,
		origin: null,
		hash: null,
	});
	expect(readSkillFile("Just words.").body).toBe("Just words.");
});
