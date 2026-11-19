import { z } from "zod";
import {
	type ProductTools,
	productTool,
	type SkillSource,
} from "../contract/product";

/**
 * Skills as prose: the gate that decides which of a product's skills a turn
 * may carry, the one tool both channels read a fitting skill with, and the
 * renderer that writes the fitting ones into a session's instructions for a
 * channel that cannot call a tool. A skill is the
 * procedure behind one kind of question, loaded only on the turns that ask
 * it; what is true of every turn is prompt. Whether the mechanism runs at
 * all is the `tools` document's `skills_enabled`, read by the caller of
 * either channel: nothing here reads a switch.
 */

/** Whether the typed vocabulary of tool names is read as authored, or translated for a live session. */
export type SkillChannel = "typed" | "live";

export interface SkillTurn {
	surface: string;
	/** The operator's enabled tool keys. */
	enabledTools: readonly string[];
	/** Defaults to `"typed"`. Gating ignores it; only the rendered words change. */
	channel?: SkillChannel;
}

/**
 * A skill whose tools the turn does not have is worse than no skill: a
 * procedure telling the model to call something that is not registered.
 * Both gates read empty as no restriction; `requiresTools` is any-of. A
 * non-empty scope naming no surface that exists matches nothing, so a skill
 * left behind by a retired surface fails closed rather than escaping.
 */
export function skillFitsTurn(
	skill: Pick<SkillSource, "surfaces" | "requiresTools">,
	turn: SkillTurn,
): boolean {
	const surfaces = skill.surfaces ?? [];
	const requires = skill.requiresTools ?? [];
	if (surfaces.length > 0 && !surfaces.includes(turn.surface)) return false;
	if (
		requires.length > 0 &&
		!requires.some((tool) => turn.enabledTools.includes(tool))
	)
		return false;
	return true;
}

/** The skills a turn of this shape carries, by name; none while the operator switched skills off. */
export function fittingSkills(
	skills: readonly SkillSource[],
	turn: SkillTurn,
	skillsEnabled: boolean,
): SkillSource[] {
	if (!skillsEnabled) return [];
	return skills
		.filter((skill) => skillFitsTurn(skill, turn))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The reader's name, the same on a typed turn and in a live session. */
export const READ_SKILL = "readSkill";

/**
 * The tool a turn reads a skill with, when any fits: its description lists
 * each fitting skill by name and "use when" line, and a call answers the
 * skill's instructions. The list is in the tool's description and its
 * parameters, so it is part of the agent version a typed turn runs on: a
 * skill added, removed or redescribed is one new version, and an edit to a
 * skill's instructions alone is none, since they are read at the call.
 */
export function skillTools(skills: readonly SkillSource[]): ProductTools {
	const [first, ...rest] = skills.map((skill) => skill.name);
	if (first === undefined) return {};
	const listed = skills
		.map(({ name, description }) => `- ${name}: ${description.trim()}`)
		.join("\n");
	return {
		[READ_SKILL]: productTool({
			description: `Read the method behind one kind of question before you answer it, then follow it. Don't announce it. The skills:\n${listed}`,
			parameters: z.object({
				name: z.enum([first, ...rest]).describe("The skill to read."),
			}),
			async execute({ name }) {
				const skill = skills.find((s) => s.name === name);
				return skill
					? { name, instructions: skill.instructions }
					: { error: "not_available" };
			},
		}),
	};
}

/**
 * How much of the skills a session's instructions may carry, in characters.
 * A session that cannot load a skill on demand pays for every character on
 * every turn, so a body that fits is written in full, one that does not is
 * named with its "use when" line, and the total stops growing at `totalChars`.
 */
export interface SkillsBudget {
	perSkillChars: number;
	totalChars: number;
	maxSkills: number;
}

export const DEFAULT_SKILLS_BUDGET: SkillsBudget = {
	perSkillChars: 3_000,
	totalChars: 8_000,
	maxSkills: 24,
};

export interface RenderSkillsOptions {
	budget?: SkillsBudget;
	/**
	 * The typed channel's tool ids and what each is called on a live session.
	 * A body is authored once, in the typed vocabulary, and translated here at
	 * the one point the live text is produced; only backticked ids are renamed,
	 * because the same words appear un-ticked in prose.
	 */
	liveToolNames?: Readonly<Record<string, string>>;
	/** The paragraph that opens the block, telling the model what follows and how to use it. */
	opening?: string;
}

const DEFAULT_OPENING =
	"YOUR SKILLS — the method behind the questions that need one. On this channel there is no skill to load: each procedure this session can carry is written out below, in full where it fits and as a name and a line about when to use it where it does not. Before you answer a question that needs a method, follow the skill for it. Don't announce that you are using one; just do it and answer. A skill given only by name is still yours: keep its judgement of when to act and answer from the tools it names.";

export function skillTextForChannel(
	text: string,
	channel: SkillChannel,
	liveToolNames: Readonly<Record<string, string>> = {},
): string {
	const ids = Object.keys(liveToolNames);
	if (channel !== "live" || ids.length === 0) return text;
	const literal = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const ticked = new RegExp(`\`(${ids.map(literal).join("|")})\``, "g");
	return text.replace(ticked, (_, id: string) => `\`${liveToolNames[id]}\``);
}

/**
 * The skills a session of this shape carries, as one block, or "" when
 * nothing fits. Sorted by name so both channels present the catalogue in
 * one order and the budget is spent deterministically. Names are reserved
 * first, because a skill the model cannot read in full is still one it knows
 * to reach for; bodies spend what is left.
 */
export function renderSkillsBlock(
	skills: readonly SkillSource[],
	turn: SkillTurn,
	options: RenderSkillsOptions = {},
): string {
	const budget = options.budget ?? DEFAULT_SKILLS_BUDGET;
	const opening = options.opening ?? DEFAULT_OPENING;
	const channel = turn.channel ?? "typed";
	const translate = (text: string) =>
		skillTextForChannel(text, channel, options.liveToolNames);
	const fitting = skills
		.filter((skill) => skillFitsTurn(skill, turn))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, budget.maxSkills);
	if (fitting.length === 0) return "";

	const open = "<skills>\n";
	const close = "\n</skills>";
	const headings = fitting.map(
		(skill) => `## ${skill.name}\n${translate(skill.description.trim())}`,
	);
	let spent = open.length + opening.length + close.length;
	let named = 0;
	for (const heading of headings) {
		const cost = heading.length + 2;
		if (spent + cost > budget.totalChars) break;
		spent += cost;
		named++;
	}
	if (named === 0) return "";

	const entries = headings.slice(0, named).map((heading, i) => {
		const body = translate((fitting[i] as SkillSource).instructions.trim());
		const cost = body.length + 2;
		const fits =
			body.length > 0 &&
			body.length <= budget.perSkillChars &&
			spent + cost <= budget.totalChars;
		if (!fits) return heading;
		spent += cost;
		return `${heading}\n\n${body}`;
	});
	return `${open}${opening}\n\n${entries.join("\n\n")}${close}`;
}
