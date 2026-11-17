import { afterEach, beforeEach, expect, test } from "bun:test";
import { configure } from "@platform/llm/testing";
import { z } from "zod";
import { productTool } from "../contract/product";
import { DEFAULT_AGENT_SETTINGS } from "../settings";
import { agentDefinition } from "./definition";

let restore = () => {};
beforeEach(() => {
	restore = configure({
		AZURE_OPENAI_RESOURCE_NAME: "account",
		AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
	});
});
afterEach(() => restore());

const search = productTool({
	description: "Search the library.",
	parameters: z.object({ query: z.string() }),
	execute: async () => [],
});
const lookup = productTool({
	description: "Look a record up.",
	parameters: z.object({ id: z.string() }),
	execute: async () => null,
});

test("web search is the service's tool, and every backend tool is a function tool", async () => {
	const definition = await agentDefinition({
		fixed: "Be brief.",
		clientTools: [],
		serverTools: { search, lookup },
		webSearch: true,
		skills: [],
		settings: DEFAULT_AGENT_SETTINGS,
	});
	expect(definition.tools.map((t) => ("name" in t ? t.name : t.type))).toEqual([
		"web_search",
		"search",
		"lookup",
	]);
});
