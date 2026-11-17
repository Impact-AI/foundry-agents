import {
	type FakeState,
	HttpError,
	ok,
	type Route,
	text,
	type VersionRecord,
} from "./fake-state";

/**
 * Voice agents (preview) on the stand-in: a version of `kind: "voice"`
 * and the voice conversations the
 * service keeps of a session — none, because nothing here keeps one. Every
 * call that touches a voice agent needs the opt-in the SDK sends for it, as
 * the service has it; a definition is read as strictly as the host's own
 * needs it: a model, instructions and their inputs, a transcriber (off
 * unless set, so the host must set one), a voice, function tools whose
 * parameters carry no `$schema` (the service takes such a version and then
 * never applies it to a session) and no other kind of tool, no sub-agent (this deployment consults
 * none), and `store` false, which is the only value this deployment ever
 * sends.
 */

export const VOICE_AGENTS = "VoiceAgents=V1Preview";

type Body = Record<string, unknown>;

const object = (value: unknown, name: string): Body => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HttpError(400, `${name} is an object`);
	return value as Body;
};

export function isVoice(versions: readonly VersionRecord[]): boolean {
	return versions.at(-1)?.definition.kind === "voice";
}

/** The opt-in, on a call that touches a voice agent. */
export function requireVoiceOptIn(headers: Headers): void {
	if (headers.get("foundry-features") !== VOICE_AGENTS)
		throw new HttpError(
			403,
			`voice agents are a preview: send the foundry-features header ${VOICE_AGENTS}`,
		);
}

export function checkedVoiceDefinition(value: Body): Body {
	text(value, "model");
	if (value.model_type !== "managed" && value.model_type !== "self_deployed")
		throw new HttpError(
			400,
			"definition.model_type is managed or self_deployed",
		);
	if (typeof value.instructions !== "string")
		throw new HttpError(400, "definition.instructions is a string");
	const inputs = object(value.structured_inputs ?? {}, "structured_inputs");
	for (const [name, input] of Object.entries(inputs))
		object(object(input, name).schema, `${name}.schema`);
	for (const placeholder of value.instructions.matchAll(/\{\{(\w+)\}\}/g))
		if (!((placeholder[1] as string) in inputs))
			throw new HttpError(
				400,
				`{{${placeholder[1]}}} names no declared structured input`,
			);
	const audio = object(value.audio, "audio");
	text(
		object(object(audio.input, "audio.input").transcription, "transcription"),
		"model",
	);
	text(object(audio.output, "audio.output"), "voice");
	if (value.store !== false)
		throw new HttpError(400, "this stand-in keeps nothing: store is false");
	if (value.subagent_config !== undefined)
		throw new HttpError(
			400,
			"this deployment's voice agent consults no sub-agent",
		);
	const tools = value.tools ?? [];
	if (!Array.isArray(tools))
		throw new HttpError(400, "definition.tools is a list");
	for (const tool of tools as Body[]) {
		if (tool.type !== "function")
			throw new HttpError(
				400,
				"every tool of a voice agent here is a function",
			);
		text(tool, "name");
		if (
			JSON.stringify(object(tool.parameters, "parameters")).includes(
				'"$schema"',
			)
		)
			throw new HttpError(
				400,
				`${String(tool.name)}'s parameters name $schema: the service never applies such a version`,
			);
	}
	return value;
}

/** The voice conversations of a voice agent: what `store: true` would keep, so never anything here. */
export function voiceConversationRoutes(state: FakeState): Route[] {
	const voiceAgent = (name: string, headers: Headers) => {
		requireVoiceOptIn(headers);
		if (!isVoice(state.agents.get(name) ?? []))
			throw new HttpError(404, `no voice agent ${name}`);
	};
	return [
		{
			method: "GET",
			pattern: /^\/agents\/([^/]+)\/endpoint\/protocols\/voice\/conversations$/,
			project: true,
			handle({ match, headers }) {
				voiceAgent(match[1] as string, headers);
				return ok({
					object: "list",
					data: [],
					first_id: null,
					last_id: null,
					has_more: false,
				});
			},
		},
		{
			method: "GET",
			pattern:
				/^\/agents\/([^/]+)\/endpoint\/protocols\/voice\/conversations\/([^/]+)(?:\/audio)?$/,
			project: true,
			handle({ match, headers }) {
				voiceAgent(match[1] as string, headers);
				throw new HttpError(404, `no voice conversation ${match[2]}`);
			},
		},
	];
}
