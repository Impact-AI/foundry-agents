import { expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceResolved, VoiceTuningView } from "@/src/backend/voice";
import messages from "../../../messages/en.json";
import { VoiceTuningCard } from "./VoiceTuningCard";
import { boundedNumber, nextTuning, saveTuning } from "./voice-tuning";

/**
 * Settings → Voice tuning: the tuning a change makes, the bound a timer is
 * held to, the call that saves it, and the card drawn at the values a
 * session runs with — never a bare "default".
 */

const baseline: VoiceResolved = {
	engine: "speechToSpeech",
	modelSource: "deployment",
	managedModel: null,
	realtimeModel: "gpt-realtime-2.1",
	voice: "en-US-AvaMultilingualNeural",
	turnDetection: "azure_semantic_vad_multilingual",
	silenceMs: null,
	threshold: null,
	prefixPaddingMs: null,
	noiseReduction: "azure_deep_noise_suppression_headset",
	transcription: "mai-transcribe",
	reasoningEffort: "low",
	interimResponses: true,
};

const view: VoiceTuningView = {
	tuning: { noiseReduction: "azure_deep_noise_suppression" },
	choices: {
		engines: ["cascade", "speechToSpeech"],
		modelSources: ["deployment", "managed"],
		managedModels: [
			{ name: "gpt-realtime-2.1", scope: "global" },
			{ name: "gpt-realtime-2.1-datazone", scope: "dataZone" },
		],
		realtimeModels: ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"],
		voices: [
			"en-US-AvaMultilingualNeural",
			"en-US-AndrewMultilingualNeural",
			"marin",
		],
		openaiVoices: ["marin"],
		turnDetections: [
			"azure_semantic_vad_multilingual",
			"azure_semantic_vad",
			"server_vad",
			"semantic_vad",
		],
		noiseReductions: [
			"azure_deep_noise_suppression",
			"azure_deep_noise_suppression_headset",
			"azure_personal_noise_suppression",
		],
		transcriptions: ["mai-transcribe", "gpt-4o-transcribe"],
		reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
		interimResponses: true,
		bounds: {
			silenceMs: { min: 100, max: 3000, step: 50, integer: true },
			threshold: { min: 0, max: 1, step: 0.05, integer: false },
			prefixPaddingMs: { min: 0, max: 2000, step: 50, integer: true },
		},
	},
	effective: { ...baseline, noiseReduction: "azure_deep_noise_suppression" },
	baseline,
};

test("a value chosen back to the deployment's own clears the field, and the engine clears what depends on it", () => {
	expect(
		nextTuning({}, "noiseReduction", "azure_deep_noise_suppression", baseline),
	).toEqual({ noiseReduction: "azure_deep_noise_suppression" });
	expect(
		nextTuning(
			{ noiseReduction: "azure_deep_noise_suppression" },
			"noiseReduction",
			baseline.noiseReduction,
			baseline,
		),
	).toEqual({});
	expect(
		nextTuning(
			{
				transcription: "gpt-4o-transcribe",
				reasoningEffort: "high",
				silenceMs: 700,
				voice: "en-US-AndrewMultilingualNeural",
			},
			"engine",
			"cascade",
			baseline,
		),
	).toEqual({ engine: "cascade", voice: "en-US-AndrewMultilingualNeural" });
	expect(
		nextTuning(
			{ reasoningEffort: "high" },
			"realtimeModel",
			"gpt-realtime-2.1-mini",
			baseline,
		),
	).toEqual({ realtimeModel: "gpt-realtime-2.1-mini" });
	expect(nextTuning({ silenceMs: 700 }, "silenceMs", null, baseline)).toEqual(
		{},
	);
});

test("changing the engine clears an OpenAI voice, which the cascade refuses, and keeps an Azure one", () => {
	expect(
		nextTuning({ voice: "marin" }, "engine", "cascade", baseline, ["marin"]),
	).toEqual({ engine: "cascade" });
	expect(
		nextTuning(
			{ voice: "en-US-AndrewMultilingualNeural" },
			"engine",
			"cascade",
			baseline,
			["marin"],
		),
	).toEqual({ engine: "cascade", voice: "en-US-AndrewMultilingualNeural" });
});

test("a timer is held to its bound, and a blank one is the service's", () => {
	const { silenceMs, threshold } = view.choices.bounds;
	expect(boundedNumber("40", silenceMs)).toBe(100);
	expect(boundedNumber("712.4", silenceMs)).toBe(712);
	expect(boundedNumber("0.62", threshold)).toBe(0.6);
	expect(boundedNumber("", threshold)).toBeNull();
	expect(boundedNumber("abc", threshold)).toBeNull();
});

test("a save is a PUT of the whole tuning, and a refusal answers its code", async () => {
	const sent: { url: string; init: RequestInit }[] = [];
	const ok = await saveTuning({ engine: "cascade" }, async (url, init) => {
		sent.push({ url, init });
		return Response.json(view);
	});
	expect(ok.view).toEqual(view);
	expect(sent[0]?.url).toBe("/api/voice/tuning");
	expect(sent[0]?.init.method).toBe("PUT");
	expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ engine: "cascade" });
	const refused = await saveTuning({}, async () =>
		Response.json({ code: "forbidden" }, { status: 403 }),
	);
	expect(refused.code).toBe("forbidden");
});

test("the card shows the value every control runs with, the deployment's marked, and a timer the session is not sent as the service's", () => {
	const html = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			<VoiceTuningCard initial={view} />
		</NextIntlClientProvider>,
	);
	const t = messages.settings.voiceTuning;
	expect(html).toContain(t.heading);
	expect(html).toContain(
		'<option value="azure_deep_noise_suppression" selected="">azure_deep_noise_suppression</option>',
	);
	expect(html).toContain(
		`azure_deep_noise_suppression_headset (this deployment&#x27;s)`,
	);
	const escaped = (text: string) => text.replaceAll("'", "&#x27;");
	expect(html).toContain(`placeholder="${escaped(t.serviceValue)}"`);
	expect(html).toContain(t.controls.realtimeModel);
	expect(html).toContain(t.controls.reasoningEffort);
	expect(html).toContain(escaped(t.reset));
	expect(html).not.toMatch(/>Default</);
});

test("with an OpenAI voice the fillers are drawn off and fixed, and the voice is named as OpenAI's", () => {
	const openai: VoiceTuningView = {
		...view,
		tuning: { voice: "marin" },
		choices: { ...view.choices, interimResponses: false },
		effective: { ...baseline, voice: "marin", interimResponses: false },
	};
	const html = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			<VoiceTuningCard initial={openai} />
		</NextIntlClientProvider>,
	);
	const t = messages.settings.voiceTuning;
	expect(html).toContain(
		'<option value="marin" selected="">marin (OpenAI)</option>',
	);
	expect(html).toContain(t.openaiVoiceNoFillers);
	expect(html).toMatch(
		/<select[^>]*disabled=""[^>]*>(?:(?!<\/select>).)*value="off" selected=""/s,
	);
	const azure = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			<VoiceTuningCard initial={view} />
		</NextIntlClientProvider>,
	);
	expect(azure).not.toContain(t.openaiVoiceNoFillers);
});

test("beside the realtime model's own turn detection the panel says which noise suppression runs, and choosing a detection clears a chosen one", () => {
	const semantic: VoiceTuningView = {
		...view,
		tuning: { turnDetection: "semantic_vad" },
		choices: {
			...view.choices,
			noiseReductions: ["azure_deep_noise_suppression"],
		},
		effective: {
			...baseline,
			turnDetection: "semantic_vad",
			noiseReduction: "azure_deep_noise_suppression",
		},
	};
	const t = messages.settings.voiceTuning;
	const render = (initial: VoiceTuningView) =>
		renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
				<VoiceTuningCard initial={initial} />
			</NextIntlClientProvider>,
		);
	const html = render(semantic);
	expect(html).toContain(t.semanticVadNoise.replaceAll("'", "&#x27;"));
	expect(html).not.toContain('value="azure_personal_noise_suppression"');
	expect(render(view)).not.toContain(
		t.semanticVadNoise.replaceAll("'", "&#x27;"),
	);
	expect(
		nextTuning(
			{ noiseReduction: "azure_personal_noise_suppression" },
			"turnDetection",
			"semantic_vad",
			baseline,
		),
	).toEqual({ turnDetection: "semantic_vad" });
});

test("changing the model source clears the model, the transcriber and the effort, and a managed model clears its effort", () => {
	expect(
		nextTuning(
			{
				realtimeModel: "gpt-realtime-2.1-mini",
				transcription: "gpt-4o-transcribe",
				reasoningEffort: "high",
				noiseReduction: "azure_deep_noise_suppression",
			},
			"modelSource",
			"managed",
			baseline,
		),
	).toEqual({
		modelSource: "managed",
		noiseReduction: "azure_deep_noise_suppression",
	});
	expect(
		nextTuning(
			{ modelSource: "managed", reasoningEffort: "high" },
			"managedModel",
			"gpt-realtime-2.1-datazone",
			baseline,
		),
	).toEqual({
		modelSource: "managed",
		managedModel: "gpt-realtime-2.1-datazone",
	});
	expect(
		nextTuning(
			{ managedModel: "gpt-realtime-mini" },
			"engine",
			"cascade",
			baseline,
		),
	).toEqual({ engine: "cascade" });
});

test("a managed model is drawn with where the service processes it, and the realtime model control gives way to it", () => {
	const managed: VoiceTuningView = {
		...view,
		tuning: {
			modelSource: "managed",
			managedModel: "gpt-realtime-2.1-datazone",
		},
		effective: {
			...baseline,
			modelSource: "managed",
			managedModel: "gpt-realtime-2.1-datazone",
			realtimeModel: null,
		},
	};
	const html = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			<VoiceTuningCard initial={managed} />
		</NextIntlClientProvider>,
	);
	const t = messages.settings.voiceTuning;
	const escaped = (text: string) => text.replaceAll("'", "&#x27;");
	expect(html).toContain(t.controls.modelSource);
	expect(html).toContain(
		`<option value="gpt-realtime-2.1-datazone" selected="">gpt-realtime-2.1-datazone — ${escaped(t.scopes.dataZone)}</option>`,
	);
	expect(html).toContain(`gpt-realtime-2.1 — ${t.scopes.global}`);
	expect(html).toContain(escaped(t.managedHint));
	expect(html).not.toContain(t.controls.realtimeModel);
	const own = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			<VoiceTuningCard initial={view} />
		</NextIntlClientProvider>,
	);
	expect(own).not.toContain(t.controls.managedModel);
	expect(own).not.toContain(escaped(t.managedHint));
});
