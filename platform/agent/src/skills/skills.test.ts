import { expect, test } from "bun:test";
import type { SkillSource } from "../contract/product";
import {
	DEFAULT_SKILLS_BUDGET,
	fittingSkills,
	READ_SKILL,
	renderSkillsBlock,
	skillFitsTurn,
	skillTextForChannel,
	skillTools,
} from "./skills";

/**
 * The half of skills a session that cannot load one depends on: the two
 * channels agree on which skills a turn carries, and the block never grows
 * past its budget however many rows there are.
 */

const SHIPPED: SkillSource[] = [
	{
		name: "archive-research",
		description: "Use when a question needs the archive.",
		instructions: "# Archive\n\nCall `knowledgeSearch` first.",
		requiresTools: ["knowledge"],
	},
	{
		name: "conditions-check",
		description: "Use when asked about conditions.",
		instructions: "# Conditions\n\nRead `readings`.",
		requiresTools: ["readings"],
	},
	{
		name: "plain-answer",
		description: "Use when nothing else fits.",
		instructions: "# Plain\n\nAnswer plainly.",
	},
];
const TURN = { surface: "web", enabledTools: ["knowledge", "readings"] };
const LIVE_NAMES = {
	knowledgeSearch: "searchArchive",
	readings: "readInstruments",
};

function skill(overrides: Partial<SkillSource>): SkillSource {
	return {
		name: "a-skill",
		description: "Use when the test asks for it.",
		instructions: "# A skill\n\nDo the thing.",
		...overrides,
	};
}

/** What the frame and opening cost before any skill is written. */
const OPENING =
	renderSkillsBlock([skill({ instructions: "" })], TURN).length -
	("## a-skill\nUse when the test asks for it.".length + 2);

test("the gate is surface AND any-of the required tools; empty means no restriction; a dead surface matches nothing", () => {
	const scoped = skill({ surfaces: ["web"], requiresTools: ["a", "b"] });
	expect(skillFitsTurn(scoped, { surface: "web", enabledTools: ["b"] })).toBe(
		true,
	);
	expect(skillFitsTurn(scoped, { surface: "web", enabledTools: ["c"] })).toBe(
		false,
	);
	expect(
		skillFitsTurn(skill({ surfaces: ["retired"] }), {
			surface: "web",
			enabledTools: ["b"],
		}),
	).toBe(false);
	expect(skillFitsTurn(skill({}), { surface: "web", enabledTools: [] })).toBe(
		true,
	);
});

test("the block carries exactly the skills the gate admits, and switching a tool off takes its skill off the channel", () => {
	const block = renderSkillsBlock(SHIPPED, TURN);
	for (const s of SHIPPED) expect(block).toContain(`## ${s.name}\n`);
	const without = renderSkillsBlock(SHIPPED, {
		surface: "web",
		enabledTools: ["knowledge"],
	});
	expect(without).not.toContain("## conditions-check\n");
	expect(without).toContain("## archive-research\n");
	expect(without).toContain("## plain-answer\n");
});

test("a live turn reads the live tool names in backticks only; a typed turn reads the text as authored", () => {
	const row = skill({
		description: "Use when the test asks which vocabulary `readings` is in.",
		instructions:
			"Call `knowledgeSearch`, then `readings`. `readingsHistory` keeps its name, and the word readings in prose stays.",
	});
	const live = renderSkillsBlock(
		[row],
		{ ...TURN, channel: "live" },
		{ liveToolNames: LIVE_NAMES },
	);
	expect(live).toContain("`searchArchive`");
	expect(live).toContain("`readInstruments`");
	expect(live).toContain("`readingsHistory`");
	expect(live).toContain("vocabulary `readInstruments` is in");
	expect(live).toContain("the word readings in prose");
	expect(live).not.toContain("`knowledgeSearch`");
	for (const turn of [TURN, { ...TURN, channel: "typed" as const }]) {
		const typed = renderSkillsBlock([row], turn, { liveToolNames: LIVE_NAMES });
		expect(typed).toContain("`knowledgeSearch`");
		expect(typed).not.toContain("`searchArchive`");
	}
	// No map, no translation, whatever the channel.
	expect(renderSkillsBlock([row], { ...TURN, channel: "live" })).toContain(
		"`knowledgeSearch`",
	);
});

test("the block is bounded: full bodies to the budget, then names only; an oversized body is named only", () => {
	const long = "x".repeat(2_000);
	const rows = ["alpha", "bravo", "charlie", "delta"].map((name) =>
		skill({ name, instructions: long }),
	);
	const block = renderSkillsBlock(rows, TURN, {
		budget: {
			perSkillChars: 3_000,
			totalChars: 5_000 + OPENING,
			maxSkills: 24,
		},
	});
	expect(block.split(long).length - 1).toBe(2);
	for (const name of ["alpha", "bravo", "charlie", "delta"])
		expect(block).toContain(`## ${name}\nUse when`);
	expect(block.indexOf("## alpha")).toBeLessThan(block.indexOf("## bravo"));
	const oversized = renderSkillsBlock(
		[skill({ instructions: "y".repeat(3_001) })],
		TURN,
		{
			budget: { perSkillChars: 3_000, totalChars: 100_000, maxSkills: 24 },
		},
	);
	expect(oversized).not.toContain("yyyy");
	expect(oversized).toContain("## a-skill\nUse when");
});

test("a catalogue of any size renders within the budget, skills capped", () => {
	const rows = Array.from({ length: 200 }, (_, i) =>
		skill({
			name: `skill-${String(i).padStart(3, "0")}`,
			description: `Use when ${"the operator asks about this ".repeat(10)}`,
			instructions: "z".repeat(1_500),
		}),
	);
	const block = renderSkillsBlock(rows, TURN);
	expect(block.length).toBeLessThanOrEqual(DEFAULT_SKILLS_BUDGET.totalChars);
	expect(block.split("\n## ").length - 1).toBeLessThanOrEqual(
		DEFAULT_SKILLS_BUDGET.maxSkills,
	);
	const capped = renderSkillsBlock(rows, TURN, {
		budget: { perSkillChars: 3_000, totalChars: 1_000_000, maxSkills: 5 },
	});
	expect(capped.split("\n## ").length - 1).toBe(5);
	expect(capped).toContain("## skill-004\n");
	expect(capped).not.toContain("## skill-005\n");
});

test("a product's opening replaces the default; nothing fitting is no block at all", () => {
	expect(
		renderSkillsBlock(SHIPPED, TURN, { opening: "THE METHODS." }),
	).toContain("<skills>\nTHE METHODS.\n\n## ");
	expect(
		renderSkillsBlock([skill({ surfaces: ["retired"] })], {
			surface: "web",
			enabledTools: [],
		}),
	).toBe("");
	expect(renderSkillsBlock([], TURN)).toBe("");
});

test("a tool id is renamed as the literal it is: a dot in it matches a dot, and a bracket is no pattern", () => {
	expect(
		skillTextForChannel("Call `web.search`, never `webXsearch`.", "live", {
			"web.search": "webSearch",
		}),
	).toBe("Call `webSearch`, never `webXsearch`.");
	expect(
		skillTextForChannel("Use `notes(`.", "live", { "notes(": "notes" }),
	).toBe("Use `notes`.");
});

test("a turn's reader lists the fitting skills by name and \"use when\" line, answers one's instructions, and is absent when none fits or skills are off", async () => {
	const rows = [
		skill({ name: "zeta", description: "Use when zeta." }),
		skill({
			name: "alpha",
			description: "Use when alpha.",
			instructions: "Do alpha.",
		}),
		skill({ name: "elsewhere", surfaces: ["retired"] }),
	];
	const fitting = fittingSkills(rows, TURN, true);
	expect(fitting.map((s) => s.name)).toEqual(["alpha", "zeta"]);
	expect(fittingSkills(rows, TURN, false)).toEqual([]);
	expect(skillTools([])).toEqual({});
	const reader = skillTools(fitting)[READ_SKILL];
	expect(reader?.description).toContain(
		"- alpha: Use when alpha.\n- zeta: Use when zeta.",
	);
	expect(reader?.description).not.toContain("Do alpha.");
	expect(await reader?.execute?.({ name: "alpha" }, {} as never)).toEqual({
		name: "alpha",
		instructions: "Do alpha.",
	});
});
