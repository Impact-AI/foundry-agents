/**
 * The tools the backend briefs the browser to register, as `GET /identity/me`
 * answers them under `stageTools`: a name, the description the model reads
 * and a JSON-schema object for the arguments. The browser registers exactly
 * this list — a handler with no brief is never registered, a brief with no
 * handler is dropped — so the surface block and the controls cannot drift.
 */
export interface StageToolBrief {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export const STAGE_TOOL_NAMES = [
	"showLibrary",
	"openDocument",
	"presentContent",
	"showChart",
	"showRecord",
	"showRecords",
	"clearStage",
	"suggestNext",
] as const;

export type StageToolName = (typeof STAGE_TOOL_NAMES)[number];

export function isStageToolName(value: unknown): value is StageToolName {
	return (STAGE_TOOL_NAMES as readonly unknown[]).includes(value);
}

const EMPTY_SCHEMA = { type: "object", properties: {} };

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The briefs as the wire has them, read defensively; an unknown name is dropped. */
export function readStageToolBriefs(value: unknown): StageToolBrief[] {
	if (!Array.isArray(value)) return [];
	const out: StageToolBrief[] = [];
	for (const entry of value) {
		const brief = record(entry);
		if (!brief || !isStageToolName(brief.name)) continue;
		if (out.some((b) => b.name === brief.name)) continue;
		out.push({
			name: brief.name,
			description:
				typeof brief.description === "string" ? brief.description : "",
			parameters: record(brief.parameters) ?? EMPTY_SCHEMA,
		});
	}
	return out;
}

/**
 * A brief's JSON schema as the Standard Schema object CopilotKit's frontend
 * tool takes. The runtime reads `toJSONSchema` first and sends that to the
 * agent as is; the validator passes the arguments through, because every
 * handler already reads them defensively.
 */
export function briefSchema(brief: StageToolBrief) {
	return {
		"~standard": {
			version: 1 as const,
			vendor: "stage-brief",
			validate: (value: unknown) => ({
				value: (record(value) ?? {}) as Record<string, unknown>,
			}),
		},
		toJSONSchema: () => brief.parameters,
	};
}
