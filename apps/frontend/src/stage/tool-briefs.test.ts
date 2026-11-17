import { expect, test } from "bun:test";
import {
	briefSchema,
	readStageToolBriefs,
	STAGE_TOOL_NAMES,
} from "./tool-briefs";

const wire = [
	{
		name: "showLibrary",
		description: "Fill the library.",
		parameters: {
			type: "object",
			properties: { query: { type: "string" } },
		},
	},
	{ name: "clearStage", description: "Clear it." },
	{ name: "launchRocket", description: "Not a stage tool.", parameters: {} },
	{ name: "showLibrary", description: "A duplicate." },
	"garbage",
];

test("only briefs for the contract's tools are kept, once each, with a schema", () => {
	const briefs = readStageToolBriefs(wire);
	expect(briefs.map((b) => b.name)).toEqual(["showLibrary", "clearStage"]);
	expect(briefs[1]?.parameters).toEqual({ type: "object", properties: {} });
	expect(readStageToolBriefs(undefined)).toEqual([]);
	for (const name of STAGE_TOOL_NAMES)
		expect(readStageToolBriefs([{ name, description: "" }])).toHaveLength(1);
});

test("the brief's schema reaches CopilotKit as is, and arguments pass through", () => {
	const [brief] = readStageToolBriefs(wire);
	if (!brief) throw new Error("no brief");
	const schema = briefSchema(brief);
	expect(schema.toJSONSchema()).toBe(brief.parameters);
	expect(schema["~standard"].validate({ query: "x" })).toEqual({
		value: { query: "x" },
	});
	expect(schema["~standard"].validate("nonsense")).toEqual({ value: {} });
});
