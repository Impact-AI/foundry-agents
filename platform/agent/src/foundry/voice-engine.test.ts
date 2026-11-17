import { expect, test } from "bun:test";
import { DEFAULT_AGENT_SETTINGS } from "../settings";
import { managedVoiceModel } from "../voice-models";
import {
	sessionVoiceEngine,
	VOICE_LIVE_DEFAULT_MODELS,
	voiceEnginesRunning,
	voiceLiveModel,
} from "./voice-engine";

test("the Foundry voice agent is the default runtime; Voice Live is the opt-in", () => {
	expect(DEFAULT_AGENT_SETTINGS.voice.runtime).toBe("agent");
});

test("a demo deployment's Voice Live runs on the global models", () => {
	expect(voiceLiveModel("speechToSpeech", null, false).name).toBe(
		"gpt-realtime-2.1",
	);
	expect(voiceLiveModel("cascade", null, false).name).toBe("gpt-5.4");
});

test("a hardened deployment's Voice Live runs on the data-zone models", () => {
	const speech = voiceLiveModel("speechToSpeech", null, true);
	expect(speech.name).toBe("gpt-realtime-2.1-datazone");
	expect(speech.scope).toBe("dataZone");
	expect(voiceLiveModel("cascade", null, true).name).toBe("gpt-5-mini");
});

test("the agent document's managed model wins over the mode's default", () => {
	const chosen = managedVoiceModel("gpt-realtime-2.1-mini");
	if (!chosen) throw new Error("gpt-realtime-2.1-mini is in the table");
	expect(voiceLiveModel("speechToSpeech", chosen, true)).toBe(chosen);
	expect(voiceLiveModel("speechToSpeech", chosen, false)).toBe(chosen);
	const text = managedVoiceModel("gpt-5-nano");
	if (!text) throw new Error("gpt-5-nano is in the table");
	expect(voiceLiveModel("cascade", text, true)).toBe(text);
});

test("every default model is one the table lists, for its engine", () => {
	for (const scope of Object.values(VOICE_LIVE_DEFAULT_MODELS))
		for (const [engine, name] of Object.entries(scope))
			expect(managedVoiceModel(name)?.engine as string | undefined).toBe(
				engine,
			);
});

test("on Voice Live speech-to-speech runs with no realtime deployment; on a voice agent it falls back to the cascade", () => {
	const voice = {
		...DEFAULT_AGENT_SETTINGS.voice,
		engine: "speechToSpeech" as const,
	};
	expect(
		sessionVoiceEngine({ ...voice, runtime: "voiceLive" }, "base", undefined),
	).toBe("speechToSpeech");
	expect(
		sessionVoiceEngine({ ...voice, runtime: "agent" }, "base", undefined),
	).toBe("cascade");
	expect(
		voiceEnginesRunning({ ...voice, runtime: "agent" }, undefined),
	).toEqual(["cascade"]);
});
