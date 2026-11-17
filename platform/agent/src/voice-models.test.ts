import { expect, test } from "bun:test";
import { OPENAI_VOICES, TRANSCRIBERS, VOICE_ENGINES } from "./settings";
import {
	MANAGED_VOICE_MODELS,
	managedModelsFor,
	managedTranscriber,
	managedVoiceModel,
	PROCESSING_SCOPES,
} from "./voice-models";

/**
 * The managed models' table: one row per name, each name on one engine, and
 * every capability drawn from the lists the rest of the code checks against,
 * so the table cannot offer a value the settings would refuse.
 */

test("every managed model is named once, on one engine, with a scope, efforts, voices and transcribers from the settings' own lists", () => {
	const names = MANAGED_VOICE_MODELS.map((model) => model.name);
	expect(new Set(names).size).toBe(names.length);
	for (const model of MANAGED_VOICE_MODELS) {
		expect(VOICE_ENGINES).toContain(model.engine);
		expect(PROCESSING_SCOPES).toContain(model.scope);
		expect(model.transcribers.length).toBeGreaterThan(0);
		for (const transcriber of model.transcribers)
			expect(TRANSCRIBERS).toContain(transcriber);
		// Only a realtime model speaks the realtime models' own voices.
		expect(model.openaiVoices).toBe(model.engine === "speechToSpeech");
	}
	expect(OPENAI_VOICES.length).toBeGreaterThan(0);
});

test("the realtime names carry their scope in the name, and the cascade's depend on the region", () => {
	for (const model of managedModelsFor("speechToSpeech"))
		expect(model.scope).toBe(
			model.name.endsWith("-datazone") ? "dataZone" : "global",
		);
	for (const model of managedModelsFor("cascade"))
		expect(model.scope).toBe("byRegion");
	expect(managedModelsFor("cascade").map((m) => m.name)).toEqual([
		"gpt-5.4",
		"gpt-5-mini",
		"gpt-5-nano",
	]);
});

test("the efforts are each model's own: the 2.1 family reasons, 1.5 and mini do not, and a cascade never offers the realtime scale's xhigh", () => {
	expect(managedVoiceModel("gpt-realtime-2.1")?.efforts).toContain("xhigh");
	expect(managedVoiceModel("gpt-realtime-2.1-mini")?.efforts).toEqual([
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	]);
	expect(managedVoiceModel("gpt-realtime-mini")?.efforts).toEqual([]);
	expect(managedVoiceModel("gpt-realtime-1.5")?.efforts).toEqual([]);
	for (const model of managedModelsFor("cascade"))
		expect(model.efforts).not.toContain("xhigh");
});

test("a managed cascade takes only the cascade's two transcribers, and an unlisted one is replaced by the model's first", () => {
	const text = managedVoiceModel("gpt-5-mini");
	if (!text) throw new Error("gpt-5-mini is in the table");
	expect(text.transcribers).toEqual(["mai-transcribe", "azure-speech"]);
	expect(managedTranscriber(text, "azure-speech")).toBe("azure-speech");
	expect(managedTranscriber(text, "whisper-1")).toBe("mai-transcribe");
	expect(managedVoiceModel("azure-realtime")).toBeNull();
	expect(managedVoiceModel("")).toBeNull();
});
