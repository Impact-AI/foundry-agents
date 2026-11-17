import { envString } from "@platform/config";
import { llmSettings, requireDeployment } from "@platform/llm";
import { asSchema } from "ai";
import type { ClientTool, ProductTools } from "../contract/product";
import type { AgentSettings, SearchContextSize } from "../settings";
import type { SkillPin } from "./skills";

/**
 * The agent as one version of a prompt agent: everything that is the same
 * for every person on a surface — parts one and two of the prompt with the
 * placeholder part three is sent into, every tool, the pinned skills, the
 * reasoning settings and the guardrail — and nothing that is a person's.
 * Its hash is taken over the canonical JSON of all of it, so any change an
 * operator makes, to the persona, a guardrail, the tools document, a
 * skill's default version or the reasoning, is a new version; nothing a
 * client registered can be, since the controls are all of the product's.
 */

/** The one structured input every response carries: the prompt's third part. */
export const PERSONALIZATION_INPUT = "personalization";

export interface FunctionToolDefinition {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict: false;
}

/** The service's web search: Microsoft's own Bing behind it, no resource or connection of the deployment's. */
export interface WebSearchToolDefinition {
	type: "web_search";
	search_context_size: SearchContextSize;
}

export interface PromptAgentDefinition {
	kind: "prompt";
	model: string;
	instructions: string;
	structured_inputs: Record<
		string,
		{ description: string; schema: { type: "string" }; required: true }
	>;
	tools: (FunctionToolDefinition | WebSearchToolDefinition)[];
	/** Absent when none, so a product without skills needs no preview opt-in. */
	skills?: SkillPin[];
	reasoning: {
		effort: AgentSettings["reasoningEffort"];
		summary: AgentSettings["reasoningSummary"];
	};
	rai_config?: { rai_policy_name: string };
}

export interface DefinitionInput {
	/** Parts one and two, composed and escaped. */
	fixed: string;
	/** Every control the product defines, whichever this client registered. */
	clientTools: readonly ClientTool[];
	/** The backend's tools this turn's shape enables. */
	serverTools: ProductTools;
	/** Whether the operator left web search on. */
	webSearch: boolean;
	skills: readonly SkillPin[];
	settings: Pick<
		AgentSettings,
		"reasoningEffort" | "reasoningSummary" | "webSearch"
	>;
}

function functionTool(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
): FunctionToolDefinition {
	return { type: "function", name, description, parameters, strict: false };
}

/**
 * Web search, when the operator left it on: the service runs it inside the
 * response and cites what it read. No location and no domain list: the
 * search is the open web, wherever the person is.
 */
export function webSearchTool(
	enabled: boolean,
	contextSize: SearchContextSize,
): WebSearchToolDefinition[] {
	return enabled
		? [{ type: "web_search", search_context_size: contextSize }]
		: [];
}

/** The backend's tools as function tools, each with its parameters' JSON schema. */
async function serverFunctionTools(
	serverTools: ProductTools,
): Promise<FunctionToolDefinition[]> {
	return Promise.all(
		Object.entries(serverTools).map(async ([name, tool]) =>
			functionTool(
				name,
				tool.description,
				(await asSchema(tool.parameters).jsonSchema) as Record<string, unknown>,
			),
		),
	);
}

/**
 * Every function a turn can call, the controls first: what a prompt agent's
 * version carries beside web search, and what the voice agent's carries
 * whole (`voice-definition.ts`).
 */
export async function functionTools(
	clientTools: readonly ClientTool[],
	serverTools: ProductTools,
): Promise<FunctionToolDefinition[]> {
	return [
		...clientTools.map((t) =>
			functionTool(t.name, t.description, t.parameters),
		),
		...(await serverFunctionTools(serverTools)),
	];
}

/** The chat's deployment: what a typed turn reasons on, and the cascaded voice agent's model too. */
export async function chatDeployment(): Promise<string> {
	return requireDeployment((await llmSettings()).deployments, "chat");
}

/**
 * The realtime deployment a speech-to-speech voice agent's version names,
 * or none: the template sets it from `models.realtime` and leaves it empty
 * while that is absent. A bootstrap name, as the chat's is, never a setting.
 */
export function realtimeDeployment(): string | undefined {
	return envString("AZURE_OPENAI_REALTIME_DEPLOYMENT");
}

/** The model behind {@link realtimeDeployment}, which decides whether a session is given a reasoning effort. */
function realtimeModel(): string | undefined {
	return envString("AZURE_OPENAI_REALTIME_MODEL");
}

/** A realtime deployment a speech-to-speech version may name, and the model behind it. */
export interface RealtimeDeployment {
	deployment: string;
	/** Empty when the environment does not say: such a deployment is never sent a reasoning effort. */
	model: string;
}

/**
 * Every realtime deployment this deployment has: the one sessions run on
 * ({@link realtimeDeployment}) first, then the optional alternate a voice
 * tester may switch to (`AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT`, set
 * from `models.realtimeAlternate`). The alternate is listed only with its
 * model named and only beside a primary, since a tester chooses it by model.
 */
export function realtimeDeployments(): RealtimeDeployment[] {
	const primary = realtimeDeployment();
	if (!primary) return [];
	const listed: RealtimeDeployment[] = [
		{ deployment: primary, model: realtimeModel() ?? "" },
	];
	const alternate = envString("AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT");
	const model = envString("AZURE_OPENAI_REALTIME_ALTERNATE_MODEL");
	if (alternate && model && alternate !== primary && model !== listed[0]?.model)
		listed.push({ deployment: alternate, model });
	return listed;
}

export async function agentDefinition(
	input: DefinitionInput,
): Promise<PromptAgentDefinition> {
	const server = await serverFunctionTools(input.serverTools);
	const policy = envString("FOUNDRY_RAI_POLICY");
	return {
		kind: "prompt",
		model: await chatDeployment(),
		instructions: `${input.fixed}\n\n{{${PERSONALIZATION_INPUT}}}`,
		structured_inputs: {
			[PERSONALIZATION_INPUT]: {
				description:
					"Who the person is, what is remembered about them, what is on their screen, and their language.",
				schema: { type: "string" },
				required: true,
			},
		},
		tools: [
			...input.clientTools.map((t) =>
				functionTool(t.name, t.description, t.parameters),
			),
			...webSearchTool(input.webSearch, input.settings.webSearch.contextSize),
			...server,
		],
		...(input.skills.length ? { skills: [...input.skills] } : {}),
		reasoning: {
			effort: input.settings.reasoningEffort,
			summary: input.settings.reasoningSummary,
		},
		...(policy ? { rai_config: { rai_policy_name: policy } } : {}),
	};
}

/** JSON with every object's keys in order, so equal definitions hash equal. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** Of any kind's definition: equal definitions hash equal, and any change is a new hash. */
export function definitionHash(definition: object): string {
	return new Bun.CryptoHasher("sha256")
		.update(canonical(definition))
		.digest("hex")
		.slice(0, 32);
}
