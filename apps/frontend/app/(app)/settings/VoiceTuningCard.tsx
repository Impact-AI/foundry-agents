"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type {
	TuningBound,
	VoiceResolved,
	VoiceTuningView,
} from "@/src/backend/voice";
import { errorKey } from "@/src/errors";
import {
	Button,
	Card,
	SelectField,
	StatusLine,
	TextField,
} from "../../components/controls";
import {
	boundedNumber,
	nextTuning,
	saveTuning,
	type TuningKey,
} from "./voice-tuning";

/**
 * Settings → Voice tuning, drawn only for a voice tester (the page asks the
 * backend, which answers a tester and refuses anybody else). Every control
 * shows the value the person's sessions run with — the backend's
 * `effective`, from the function a session's open uses — and marks the
 * deployment's own value among the options; choosing that one again clears
 * the field. A change is saved at once and applies from the next voice
 * session: the engine, the model source and the model choose the voice
 * agent's version, the rest is the session's opening update. A managed
 * model is named with where the service processes it, since that can be
 * outside this deployment's region.
 */
export function VoiceTuningCard({ initial }: { initial: VoiceTuningView }) {
	const t = useTranslations("settings.voiceTuning");
	const errors = useTranslations("errors");
	const [view, setView] = useState(initial);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();
	const { effective, baseline, choices } = view;

	const save = (tuning: VoiceTuningView["tuning"]) =>
		startTransition(async () => {
			const result = await saveTuning(tuning);
			if (!result.view) {
				setProblem(errors(errorKey(result.code ?? "generic")));
				return;
			}
			setView(result.view);
			setProblem(null);
		});
	const set = (key: TuningKey, value: string | number | boolean | null) =>
		save(nextTuning(view.tuning, key, value, baseline, choices.openaiVoices));

	const choice = (
		key: keyof VoiceResolved & TuningKey,
		options: readonly string[],
		name: (option: string) => string = (option) => option,
	) => (
		<SelectField
			label={t(`controls.${key}`)}
			value={String(effective[key] ?? "")}
			disabled={pending}
			onChange={(e) => set(key, e.target.value)}
		>
			{options.map((option) => (
				<option key={option} value={option}>
					{String(baseline[key]) === option
						? t("deploymentValue", { value: name(option) })
						: name(option)}
				</option>
			))}
		</SelectField>
	);

	const timer = (key: "silenceMs" | "threshold" | "prefixPaddingMs") => {
		const bound: TuningBound = choices.bounds[key];
		return (
			<TextField
				// Remounted on every saved change, so a clamped value shows as saved.
				key={`${key}:${effective[key] ?? "service"}`}
				label={t(`controls.${key}`)}
				type="number"
				inputMode="decimal"
				min={bound.min}
				max={bound.max}
				step={bound.step}
				defaultValue={effective[key] ?? ""}
				placeholder={t("serviceValue")}
				disabled={pending}
				onBlur={(e) => {
					const value = boundedNumber(e.currentTarget.value, bound);
					if (value !== effective[key]) set(key, value);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
		);
	};

	const speechToSpeech = effective.engine === "speechToSpeech";
	const managed = effective.modelSource === "managed";
	const scopeOf = (name: string) =>
		choices.managedModels.find((model) => model.name === name)?.scope ??
		"byRegion";
	return (
		<Card
			id="voice-tuning-heading"
			heading={t("heading")}
			description={t("hint")}
			actions={
				Object.keys(view.tuning).length ? (
					<Button disabled={pending} onClick={() => save({})}>
						{t("reset")}
					</Button>
				) : null
			}
		>
			{choice("engine", choices.engines, (engine) =>
				t(`engines.${engine as "cascade" | "speechToSpeech"}`),
			)}
			{choices.modelSources.length
				? choice("modelSource", choices.modelSources, (source) =>
						t(`sources.${source as "deployment" | "managed"}`),
					)
				: null}
			{managed
				? choice(
						"managedModel",
						choices.managedModels.map((model) => model.name),
						(name) =>
							t("managedModel", {
								model: name,
								scope: t(`scopes.${scopeOf(name)}`),
							}),
					)
				: null}
			{managed ? <p className="hint">{t("managedHint")}</p> : null}
			{speechToSpeech && !managed && choices.realtimeModels.length
				? choice("realtimeModel", choices.realtimeModels)
				: null}
			{choice("voice", choices.voices, (voice) =>
				choices.openaiVoices.includes(voice)
					? t("openaiVoice", { voice })
					: voice,
			)}
			{choice("turnDetection", choices.turnDetections)}
			{effective.turnDetection !== "semantic_vad" ? (
				<>
					{timer("silenceMs")}
					{timer("threshold")}
					{timer("prefixPaddingMs")}
				</>
			) : null}
			{choice("noiseReduction", choices.noiseReductions)}
			{effective.turnDetection === "semantic_vad" ? (
				<p className="hint">{t("semanticVadNoise")}</p>
			) : null}
			{choice("transcription", choices.transcriptions)}
			{choices.reasoningEfforts.length
				? choice("reasoningEffort", choices.reasoningEfforts)
				: null}
			<SelectField
				label={t("controls.interimResponses")}
				value={effective.interimResponses ? "on" : "off"}
				// An OpenAI voice speaks with no fillers: the service refuses them beside it.
				disabled={pending || !choices.interimResponses}
				onChange={(e) => set("interimResponses", e.target.value === "on")}
			>
				{(["on", "off"] as const).map((value) => (
					<option key={value} value={value}>
						{(value === "on") === baseline.interimResponses
							? t("deploymentValue", { value: t(value) })
							: t(value)}
					</option>
				))}
			</SelectField>
			{choices.interimResponses ? null : (
				<p className="hint">{t("openaiVoiceNoFillers")}</p>
			)}
			<p className="hint">{t("nextSession")}</p>
			{problem ? <StatusLine tone="danger">{problem}</StatusLine> : null}
		</Card>
	);
}
