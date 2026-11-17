import { z } from "zod";
import {
	type ProductTools,
	productTool,
	type SkillSource,
	WEB_SEARCH,
} from "../contract/product";
import { currentTurn } from "../turn/scope";
import { readSkillVersion, type SkillPin } from "./skills";
import { searchTheWeb } from "./web-search";
import { chargeWebSearches, webSearchAvailable } from "./web-search-meter";

/**
 * What a typed turn has from the service that a voice agent cannot hold:
 * web search and skills, as function tools the backend runs.
 *
 * A voice agent takes server-side tools only through a toolbox, and "a
 * voice-based agent can have individual tools or one toolbox, but not
 * both. Attaching a toolbox replaces the agent's individual tools list"
 * (Learn, foundry/agents/how-to/configure-voice-agent). Its controls and
 * the backend's tools are function tools, so a toolbox would cost every
 * one of them. Skills reach an agent only through a toolbox too (Learn,
 * foundry/agents/how-to/tools/toolbox: Skills — in a toolbox yes, direct
 * tool integration no), and `VoiceAgentDefinition` has no `skills` field
 * (@azure/ai-projects 2.10.0). So the two are the backend's functions,
 * each running what the typed turn runs:
 *
 *   - `webSearch` runs a response on the chat's deployment with the typed
 *     turns' web search tool (`web-search.ts`) and answers with
 *     what the pages said and which pages they were. It is charged to the
 *     `toolSearch` bucket a typed turn's searches are, and refused while
 *     that bucket is empty.
 *   - `readSkill` reads the skill version a typed turn's agent version
 *     would pin, from the service (`readSkillVersion`), and its description
 *     lists the skills that fit the session, as the service lists them to
 *     a prompt agent.
 */

const READ_SKILL = "readSkill";

export interface VoiceSkill {
	pin: SkillPin;
	source: SkillSource;
}

const SEARCH_DESCRIPTION =
	"Search the web, for what the knowledge base does not hold or what is current. Give a whole question. Returns an answer grounded in the pages it read, and the pages' titles and URLs: say the answer and where it comes from by the site's name, never a URL.";

function webSearchTool() {
	return productTool({
		description: SEARCH_DESCRIPTION,
		parameters: z.object({
			query: z
				.string()
				.min(1)
				.max(500)
				.describe("The question to search for, whole."),
		}),
		async execute({ query }) {
			const { caller } = currentTurn();
			if (!(await webSearchAvailable(caller))) return { error: "rate_limited" };
			const result = await searchTheWeb(query);
			// Charged however the response ended: a search that ran was spent.
			await chargeWebSearches(caller, result.searches).catch((err: Error) =>
				console.error("[agent] web searches went uncharged:", err.message),
			);
			if (result.failed) return { error: "search_failed" };
			return { answer: result.answer, sources: result.sources };
		},
	});
}

function readSkillTool(skills: readonly VoiceSkill[]) {
	const names = skills.map((skill) => skill.pin.name) as [string, ...string[]];
	const listed = skills
		.map(({ source }) => `- ${source.name}: ${source.description.trim()}`)
		.join("\n");
	return productTool({
		description: `Read the method behind one kind of question before you answer it, then follow it. Don't announce it. The skills:\n${listed}`,
		parameters: z.object({
			name: z.enum(names).describe("The skill to read."),
		}),
		async execute({ name }) {
			const skill = skills.find((s) => s.pin.name === name);
			const instructions = skill ? await readSkillVersion(skill.pin) : null;
			return instructions === null
				? { error: "not_available" }
				: { name, instructions };
		},
	});
}

/** The tools a voice session has in place of the service's: web search when the turn has it, a skill reader when any skill fits. */
export function voiceServiceTools(input: {
	webSearch: boolean;
	skills: readonly VoiceSkill[];
}): ProductTools {
	return {
		...(input.webSearch ? { [WEB_SEARCH]: webSearchTool() } : {}),
		...(input.skills.length
			? { [READ_SKILL]: readSkillTool(input.skills) }
			: {}),
	};
}
