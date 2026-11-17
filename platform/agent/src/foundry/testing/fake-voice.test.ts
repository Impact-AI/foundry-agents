import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AgentDefinitionUnion } from "@azure/ai-projects";
import { configure } from "@platform/llm/testing";
import { scopedEnv } from "@platform/test-support";
import { hasStatus, projectClient, resetFoundryClients } from "../client";
import { FAKE_FOUNDRY_ENDPOINT, fakeFoundry } from "./fake-foundry";
import { VOICE_AGENTS } from "./fake-voice";

/**
 * The stand-in's voice agents, through `@azure/ai-projects` as the host
 * reaches them: the opt-in on every call that touches one, a definition
 * read as strictly as the host needs it, and the voice conversations a
 * session would leave with storage on — none.
 */

const restores: (() => void)[] = [];
const VOICE = { "foundry-features": VOICE_AGENTS };

const voiceDefinition = (overrides: Record<string, unknown> = {}) =>
	({
		kind: "voice",
		model_type: "self_deployed",
		model: "chat",
		instructions: "The spoken prompt.\n\n{{personalization}}",
		structured_inputs: {
			personalization: { schema: { type: "string" }, required: true },
		},
		audio: {
			input: { transcription: { model: "azure-speech" } },
			output: { voice_type: "azure-standard", voice: "a-voice" },
		},
		tools: [
			{
				type: "function",
				name: "knowledgeSearch",
				description: "Search.",
				parameters: { type: "object", properties: {} },
			},
		],
		store: false,
		...overrides,
	}) as unknown as AgentDefinitionUnion;

async function status(call: () => Promise<unknown>): Promise<number> {
	try {
		await call();
		return 200;
	} catch (err) {
		for (const code of [400, 403, 404]) if (hasStatus(err, code)) return code;
		throw err;
	}
}

beforeAll(async () => {
	const fake = fakeFoundry();
	restores.push(
		scopedEnv({ FOUNDRY_PROJECT_ENDPOINT: FAKE_FOUNDRY_ENDPOINT }),
		configure({ AZURE_OPENAI_RESOURCE_NAME: "account" }),
		fake.install(),
		resetFoundryClients,
	);
	resetFoundryClients();
	await projectClient().agents.createVersion("assistant", {
		kind: "prompt",
		model: "chat",
		instructions: "Answer.",
	} as AgentDefinitionUnion);
});

afterAll(() => {
	for (const restore of restores.reverse()) restore();
});

test("a voice version needs the opt-in, and so does every call that touches the agent after", async () => {
	const agents = projectClient().agents;
	expect(
		await status(() =>
			agents.createVersion("assistant-voice", voiceDefinition()),
		),
	).toBe(403);
	const made = await agents.createVersion(
		"assistant-voice",
		voiceDefinition(),
		{
			foundryFeatures: VOICE_AGENTS,
		},
	);
	expect(made.version).toBe("1");
	expect(await status(() => agents.get("assistant-voice"))).toBe(403);
	expect(
		await status(() =>
			agents.get("assistant-voice", { requestOptions: { headers: VOICE } }),
		),
	).toBe(200);
	const listed: string[] = [];
	for await (const version of agents.listVersions("assistant-voice", {
		requestOptions: { headers: VOICE },
	}))
		listed.push(version.version);
	expect(listed).toEqual(["1"]);
	// The prompt agent beside it is untouched by the opt-in.
	expect(await status(() => agents.get("assistant"))).toBe(200);
});

test("a definition is refused for storage on, no transcriber, a placeholder it does not declare, a sub-agent, a tool whose parameters name $schema, or any tool but a function", async () => {
	const create = (overrides: Record<string, unknown>) =>
		status(() =>
			projectClient().agents.createVersion(
				"assistant-voice",
				voiceDefinition(overrides),
				{ foundryFeatures: VOICE_AGENTS },
			),
		);
	expect(await create({ store: true })).toBe(400);
	expect(
		await create({ audio: { input: {}, output: { voice: "a-voice" } } }),
	).toBe(400);
	expect(await create({ instructions: "{{language}}" })).toBe(400);
	expect(
		await create({
			subagent_config: {
				subagents: [{ agent_name: "assistant", agent_version: "1" }],
			},
		}),
	).toBe(400);
	expect(
		await create({
			tools: [
				{
					type: "function",
					name: "knowledgeSearch",
					description: "Search.",
					parameters: { $schema: "http://json-schema.org/draft-07/schema#" },
				},
			],
		}),
	).toBe(400);
	expect(
		await create({
			tools: [{ type: "mcp", server_label: "library", connector_id: "x" }],
		}),
	).toBe(400);
	expect(
		await status(() =>
			projectClient().agents.createVersion("assistant", voiceDefinition(), {
				foundryFeatures: VOICE_AGENTS,
			}),
		),
	).toBe(400);
});

test("with storage off a voice agent keeps no conversation to list, read or play back", async () => {
	const conversations = projectClient().beta.voiceAgents.conversations;
	const listed: unknown[] = [];
	for await (const conversation of conversations.list("assistant-voice"))
		listed.push(conversation);
	expect(listed).toEqual([]);
	expect(await status(() => conversations.get("assistant-voice", "c1"))).toBe(
		404,
	);
	expect(
		await status(() => conversations.getAudio("assistant-voice", "c1")),
	).toBe(404);
	expect(
		await status(async () => {
			for await (const _ of conversations.list("assistant")) break;
		}),
	).toBe(404);
});
