import { expect, test } from "bun:test";
import { WEB_SEARCH } from "@platform/agent";
import { STAGE_TOOL_NAMES, STAGE_TOOLS } from "./stage-tools";
import { surfaceBlock } from "./surface";
import { KNOWLEDGE_SEARCH } from "./tools/knowledge-search";
import { LIST_RECORDS } from "./tools/list-records";
import { LOOKUP_RECORD } from "./tools/lookup-record";
import { METRICS } from "./tools/metrics";

const SERVER = [
	KNOWLEDGE_SEARCH,
	WEB_SEARCH,
	LOOKUP_RECORD,
	LIST_RECORDS,
	METRICS,
];

/** Every backticked name the block mentions. */
const named = (block: string) =>
	new Set([...block.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));

test("the eight controls are functions with a JSON schema each, and the block names all of them on every turn", () => {
	expect(STAGE_TOOL_NAMES).toEqual([
		"showLibrary",
		"openDocument",
		"presentContent",
		"showChart",
		"showRecord",
		"showRecords",
		"clearStage",
		"suggestNext",
	]);
	for (const tool of STAGE_TOOLS) {
		expect(tool.type).toBe("function");
		expect(tool.parameters).toMatchObject({ type: "object" });
		expect(tool.description.length).toBeGreaterThan(20);
	}
	const block = surfaceBlock({ enabledTools: [] }, "written");
	for (const name of STAGE_TOOL_NAMES) expect(named(block)).toContain(name);
});

test("the stage presents a picture and nothing else: the media route serves images only", () => {
	const present = STAGE_TOOLS.find((t) => t.name === "presentContent");
	expect(JSON.stringify(present)).not.toMatch(/video/i);
	expect(surfaceBlock({ enabledTools: [] }, "written")).not.toMatch(/video/i);
});

test("the block names exactly the server tools the turn registers: all five, the searches alone, or none", () => {
	const all = named(surfaceBlock({ enabledTools: SERVER }, "written"));
	for (const key of SERVER.filter((k) => k !== WEB_SEARCH))
		expect(all).toContain(key);
	// Web search is the service's, not a function the model calls by name.
	expect(all).not.toContain(WEB_SEARCH);
	expect(surfaceBlock({ enabledTools: SERVER }, "written")).toContain(
		"- web search — the web",
	);
	expect(surfaceBlock({ enabledTools: SERVER }, "written")).toContain(
		"When the knowledge base comes back empty",
	);

	const webOnly = surfaceBlock({ enabledTools: [WEB_SEARCH] }, "written");
	expect(named(webOnly)).not.toContain(KNOWLEDGE_SEARCH);
	expect(named(webOnly)).not.toContain(LOOKUP_RECORD);
	expect(named(webOnly)).not.toContain(METRICS);
	expect(webOnly).toContain("your first act is a web search");
	// The service keeps no search result for a later step: a control called first loses the pages.
	expect(webOnly).toContain("write your answer in that step");
	expect(webOnly).not.toContain("look a record up");

	const none = surfaceBlock({ enabledTools: [] }, "written");
	for (const key of SERVER) expect(named(none)).not.toContain(key);
	expect(none).toContain("you cannot look anything up");
	expect(none).toContain("No server-side tool is on this turn.");
});

test("every reply ends with suggestNext, and the spoken variant changes the register and nothing it names", () => {
	const written = surfaceBlock({ enabledTools: SERVER }, "written");
	const spoken = surfaceBlock({ enabledTools: SERVER }, "spoken");
	for (const block of [written, spoken]) {
		expect(block).toContain("Every reply ends with `suggestNext`");
		expect(block).toContain("Never invent media");
		expect(block).toContain("Every figure with its unit");
	}
	expect(named(spoken)).toEqual(named(written));
	// A live session's search is the backend's function, whose answer stays in the session: no step to answer within.
	expect(spoken).toContain("by the site's name");
	expect(spoken).not.toContain("write your answer in that step");
	expect(written).toContain("written in your reply");
	expect(spoken).toContain("No URL is ever spoken");
	expect(spoken).toContain("hears your voice");
	// Under the budget both channels share.
	expect(written.split("\n").length + spoken.split("\n").length).toBeLessThan(
		120,
	);
});
