/**
 * The account holds the deployments the backend names: the three roles at the
 * capacity the parameter file gives each, and the realtime model the default
 * speech-to-speech voice agent runs on, named to the backend, at the capacity
 * the environment gives it (`REALTIME_CAPACITY`, one unless set), since that
 * is what a subscription's quota decides. Without `models.realtime` there is
 * no voice deployment and the backend is named none, so the voice agent runs
 * as a cascade on `chat`.
 */
import { expect, test } from "bun:test";
import {
	allResources,
	compiledMain,
	parameterFile,
	sampleDeployment,
} from "./arm";

type ModelDeployment = { name: string; capacity: unknown };
type Deployment = { name: string; model: string };

const it = test.skipIf(compiledMain() === null);

/** The variables the voice's deployments once read; none is a parameter now. */
const GONE = [
	"VOICE_RELAY",
	"MODEL_CAPACITY_TTS",
	"MODEL_CAPACITY_STT",
	"MODEL_CAPACITY_REALTIME",
	"MODEL_CAPACITY_REALTIME_PREMIUM",
];

/** The parameter file's realtime deployment. */
function realtimeOf(): Deployment {
	const file = parameterFile({}) as { models: { realtime: Deployment } };
	return file.models.realtime;
}

/** The parameter file's models with the realtime deployment taken out. */
function withoutRealtime(): Record<string, unknown> {
	const file = parameterFile({}) as { models: Record<string, unknown> };
	const { realtime: _, ...rest } = file.models;
	return { models: rest };
}

function modelsOf(overrides: Record<string, unknown> = {}) {
	const deployment = sampleDeployment(overrides);
	if (!deployment) throw new Error("no template");
	const account = allResources(deployment).find(
		(r) => r.deployment?.name === "models",
	);
	if (!account) throw new Error("no models deployment");
	const models = (
		account.properties as {
			parameters: { models: Record<string, ModelDeployment> };
		}
	).parameters.models;
	return Object.fromEntries(
		// A role left out is null here; the account makes nothing for it.
		Object.values(models)
			.filter((m) => m !== null)
			.map((m) => [m.name, m.capacity]),
	);
}

function backendVoiceEnv(
	overrides: Record<string, unknown> = {},
	names = /REALTIME|_STT_|_TTS_/,
) {
	const deployment = sampleDeployment(overrides);
	if (!deployment) throw new Error("no template");
	const backend = allResources(deployment).find(
		(r) =>
			r.type === "Microsoft.App/containerApps" &&
			String(r.name).includes("backend"),
	);
	if (!backend) throw new Error("no backend app");
	const env = (
		backend.properties as {
			template: {
				containers: { env: { name: string; value?: string }[] }[];
			};
		}
	).template.containers[0]?.env;
	return Object.fromEntries(
		(env ?? []).filter((e) => names.test(e.name)).map((e) => [e.name, e.value]),
	);
}

it("deploys the three roles at the parameter file's capacities and the realtime model at one", () => {
	const realtime = realtimeOf();
	expect(realtime.model).toBe("gpt-realtime-2.1");
	expect(realtime).not.toHaveProperty("capacity");
	expect(modelsOf()).toEqual({
		chat: 50,
		small: 50,
		embedding: 50,
		[realtime.name]: 1,
	});
});

it("deploys the realtime model at the capacity the environment sets", () => {
	const realtime = realtimeOf();
	const { realtimeCapacity } = parameterFile({ REALTIME_CAPACITY: "7" });
	expect(realtimeCapacity).toBe("7");
	expect(modelsOf({ realtimeCapacity })[realtime.name]).toBe(7);
});

it("deploys no voice deployment when the parameter leaves the realtime model out", () => {
	expect(modelsOf(withoutRealtime())).toEqual({
		chat: 50,
		small: 50,
		embedding: 50,
	});
});

it("deploys the knowledge base's planning model only with the knowledge base, at ten unless the environment sets it, and names it to the backend", () => {
	const file = parameterFile({}) as {
		models: { knowledgeBase: Deployment & { capacity?: unknown } };
	};
	const planner = file.models.knowledgeBase;
	expect(planner.model).toBe("gpt-5-mini");
	expect(planner).not.toHaveProperty("capacity");
	expect(modelsOf()).not.toHaveProperty(planner.name);
	expect(modelsOf({ knowledgeBase: true })[planner.name]).toBe(10);
	const { knowledgeBaseCapacity } = parameterFile({
		KNOWLEDGE_BASE_CAPACITY: "3",
	});
	expect(
		modelsOf({ knowledgeBase: true, knowledgeBaseCapacity })[planner.name],
	).toBe(3);
	const env = (overrides: Record<string, unknown>) =>
		backendVoiceEnv(overrides, /^AZURE_OPENAI_KNOWLEDGE_BASE_/);
	expect(env({})).toEqual({
		AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT: "",
		AZURE_OPENAI_KNOWLEDGE_BASE_MODEL: "",
	});
	expect(env({ knowledgeBase: true })).toEqual({
		AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT: planner.name,
		AZURE_OPENAI_KNOWLEDGE_BASE_MODEL: planner.model,
	});
});

it("names the backend the realtime deployment by default, and none without it", () => {
	const realtime = realtimeOf();
	expect(backendVoiceEnv()).toEqual({
		AZURE_OPENAI_REALTIME_DEPLOYMENT: realtime.name,
		AZURE_OPENAI_REALTIME_MODEL: realtime.model,
		AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT: "",
		AZURE_OPENAI_REALTIME_ALTERNATE_MODEL: "",
	});
	expect(backendVoiceEnv(withoutRealtime())).toEqual({
		AZURE_OPENAI_REALTIME_DEPLOYMENT: "",
		AZURE_OPENAI_REALTIME_MODEL: "",
		AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT: "",
		AZURE_OPENAI_REALTIME_ALTERNATE_MODEL: "",
	});
});

it("deploys a voice tester's alternate realtime model only when the parameter names one, at the capacity the environment sets, and names it to the backend", () => {
	const file = parameterFile({}) as { models: Record<string, unknown> };
	const alternate = {
		name: "realtime-mini",
		model: "gpt-realtime-2.1-mini",
		version: "2026-07-07",
		sku: "GlobalStandard",
	};
	const withAlternate = {
		models: { ...file.models, realtimeAlternate: alternate },
	};
	expect(modelsOf(withAlternate)["realtime-mini"]).toBe(1);
	const { realtimeAlternateCapacity } = parameterFile({
		REALTIME_ALTERNATE_CAPACITY: "5",
	});
	expect(
		modelsOf({ ...withAlternate, realtimeAlternateCapacity })["realtime-mini"],
	).toBe(5);
	expect(backendVoiceEnv(withAlternate)).toMatchObject({
		AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT: "realtime-mini",
		AZURE_OPENAI_REALTIME_ALTERNATE_MODEL: "gpt-realtime-2.1-mini",
	});
});

test("the parameter file reads none of the voice's old variables", () => {
	const file = JSON.stringify(parameterFile({}));
	const raw = JSON.stringify(
		parameterFile(Object.fromEntries(GONE.map((v) => [v, "sentinel-value"]))),
	);
	expect(raw).toBe(file);
	expect(raw).not.toContain("sentinel-value");
});
