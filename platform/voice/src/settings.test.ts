import { afterEach, expect, test } from "bun:test";
import { fakeConfigStore } from "@platform/config/testing";
import {
	DEFAULT_VOICE_SETTINGS,
	liveVoiceAudio,
	parseVoiceSettings,
	resetVoiceSettings,
	voiceSettings,
} from "./settings";

let restore = () => {};

afterEach(() => {
	restore();
	resetVoiceSettings();
});

test("a stored document is merged leaf by leaf: a wrong shape keeps the default, and no bound can be removed", () => {
	const settings = parseVoiceSettings({
		live: {
			stageCallTimeoutMs: 4_000,
			drainGraceMs: "many",
			settleWaitMs: -1,
			updateTimeoutMs: 0,
			toolNudgeMs: 0,
			extra: 1,
		},
		speech: { voice: "a relay that went at the cut-over" },
	});
	expect(settings.live.stageCallTimeoutMs).toBe(4_000);
	expect(settings.live.drainGraceMs).toBe(
		DEFAULT_VOICE_SETTINGS.live.drainGraceMs,
	);
	expect(settings.live.settleWaitMs).toBe(
		DEFAULT_VOICE_SETTINGS.live.settleWaitMs,
	);
	expect(settings.live.updateTimeoutMs).toBe(
		DEFAULT_VOICE_SETTINGS.live.updateTimeoutMs,
	);
	// A key of a mode that went is ignored, as any unknown one is.
	expect("toolNudgeMs" in settings.live).toBe(false);
	expect("extra" in settings.live).toBe(false);
	expect("speech" in settings).toBe(false);
});

test("the store is read through the memo, and forgotten on reset", async () => {
	restore = fakeConfigStore({ voice: { live: { drainGraceMs: 2_000 } } });
	resetVoiceSettings();
	expect((await voiceSettings()).live.drainGraceMs).toBe(2_000);
});

test("a voice agent's session speaks with a voice per tier, never a blank one, its language set one of two ways", async () => {
	expect(await liveVoiceAudio()).toEqual({
		voices: DEFAULT_VOICE_SETTINGS.live.voices,
		openaiVoices: { base: "", premium: "" },
		language: "stated",
	});
	const settings = parseVoiceSettings({
		live: {
			voices: { base: "it-IT-IsabellaMultilingualNeural", premium: " " },
			language: "guessed",
		},
	});
	expect(settings.live.voices).toEqual({
		base: "it-IT-IsabellaMultilingualNeural",
		premium: DEFAULT_VOICE_SETTINGS.live.voices.premium,
	});
	expect(settings.live.language).toBe("stated");
	expect(
		parseVoiceSettings({ live: { language: "detected" } }).live.language,
	).toBe("detected");
});

test("an OpenAI voice is kept only where the document says so, and only one the service lists: never as a tier's Azure voice", () => {
	const settings = parseVoiceSettings({
		live: {
			voices: { base: "marin", premium: "en-US-Andrew:DragonHDLatestNeural" },
			openaiVoices: { base: "nova", premium: "cedar" },
		},
	});
	// The cascade refuses an OpenAI voice, so a tier's Azure voice is never one.
	expect(settings.live.voices).toEqual({
		base: DEFAULT_VOICE_SETTINGS.live.voices.base,
		premium: "en-US-Andrew:DragonHDLatestNeural",
	});
	// A name the reference does not list would reach the service: the default, none, stands.
	expect(settings.live.openaiVoices).toEqual({ base: "", premium: "cedar" });
	expect(
		parseVoiceSettings({ live: { openaiVoices: { base: "en-US-AvaNeural" } } })
			.live.openaiVoices.base,
	).toBe("");
});

test("a failed response is asked again within bounds: a stored value outside them keeps the default, never a loop or no bound", () => {
	expect(DEFAULT_VOICE_SETTINGS.live.responseRetry).toEqual({
		attempts: 2,
		backoffMs: 1_000,
		jitterMs: 500,
	});
	expect(
		parseVoiceSettings({
			live: { responseRetry: { attempts: 3, backoffMs: 500, jitterMs: 0 } },
		}).live.responseRetry,
	).toEqual({ attempts: 3, backoffMs: 500, jitterMs: 0 });
	expect(
		parseVoiceSettings({
			live: {
				responseRetry: { attempts: 50, backoffMs: 60_000, jitterMs: -1 },
			},
		}).live.responseRetry,
	).toEqual(DEFAULT_VOICE_SETTINGS.live.responseRetry);
	expect(
		parseVoiceSettings({ live: { responseRetry: { attempts: 1.5 } } }).live
			.responseRetry.attempts,
	).toBe(2);
});
