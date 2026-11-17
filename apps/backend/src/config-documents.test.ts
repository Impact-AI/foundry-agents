import { expect, test } from "bun:test";
import {
	defaultAgentSettings,
	parseAgentSettings,
	parseToolGating,
	toolGatingDefaults,
	toolGatingOptions,
} from "@platform/agent";
import { appearanceDefaults, parseAppearance } from "@platform/appearance";
import {
	resetAppConfigClient,
	seedConfigDocuments,
	setAppConfigClient,
} from "@platform/config";
import { DEFAULT_EDGE_LIMITS, edgeLimitsFromStored } from "@platform/http";
import {
	accessSettings,
	DEFAULT_ACCESS_SETTINGS,
	DEFAULT_KNOWLEDGE_SETTINGS,
	defaultAccessSettings,
	HARDENED_ACCESS_SETTINGS,
	parseAccessSettings,
	parseKnowledgeSettings,
	resetAccessSettings,
} from "@platform/knowledge";
import { llmSettingsFromEnvironment, parseLlmSettings } from "@platform/llm";
import { DEFAULT_LIMITS, limitsFromStored } from "@platform/metering";
import {
	DEFAULT_TELEMETRY,
	fromStored as telemetryFromStored,
} from "@platform/observability/settings";
import { scopedEnv } from "@platform/test-support";
import { DEFAULT_VOICE_SETTINGS, parseVoiceSettings } from "@platform/voice";
import { configDocuments } from "./config-documents";
import { guardrails, locales, product } from "./product";

/**
 * The seeded documents are the code's defaults: each one, read back through
 * its own document's parser, is exactly what the app answers with nothing
 * stored, so seeding changes no behaviour and nothing is refused.
 */
const documents = configDocuments();

/** What each document's reader answers for a stored value, beside what it answers for none. */
const readBack: Record<string, [(stored: unknown) => unknown, unknown]> = {
	limits: [(s) => limitsFromStored(s), DEFAULT_LIMITS],
	llm: [
		(s) => parseLlmSettings(s, llmSettingsFromEnvironment()),
		llmSettingsFromEnvironment(),
	],
	voice: [(s) => parseVoiceSettings(s), DEFAULT_VOICE_SETTINGS],
	agent: [
		(s) => parseAgentSettings(s, defaultAgentSettings()),
		defaultAgentSettings(),
	],
	tools: (() => {
		const defaults = toolGatingDefaults(toolGatingOptions(product));
		return [(s: unknown) => parseToolGating(s, defaults), defaults];
	})(),
	guardrails: [
		(s) => {
			const { resolved, rejected } = guardrails.resolve(
				s as Parameters<typeof guardrails.resolve>[0],
			);
			return rejected.length > 0 ? rejected : resolved;
		},
		guardrails.defaults,
	],
	telemetry: [
		(s) => telemetryFromStored(s, DEFAULT_TELEMETRY),
		DEFAULT_TELEMETRY,
	],
	edge: [(s) => edgeLimitsFromStored(s), DEFAULT_EDGE_LIMITS],
	access: [
		(s) => parseAccessSettings(s, defaultAccessSettings()),
		defaultAccessSettings(),
	],
	knowledge: [
		(s) => parseKnowledgeSettings(s, DEFAULT_KNOWLEDGE_SETTINGS),
		DEFAULT_KNOWLEDGE_SETTINGS,
	],
	appearance: (() => {
		const defaults = appearanceDefaults(locales.codes);
		return [
			(s: unknown) => {
				const refused: string[] = [];
				const value = parseAppearance(s, defaults, refused);
				return refused.length > 0 ? refused : value;
			},
			defaults,
		];
	})(),
};

// Which documents exist is held against the operator's documentation by
// docs/configuration.test.ts; here, that each one is read back.
test("every seeded document has its reader here", () => {
	expect(Object.keys(readBack).sort()).toEqual(Object.keys(documents).sort());
});

for (const [key, [read, expected]] of Object.entries(readBack)) {
	test(`the seeded ${key} document reads back as the default`, () => {
		const stored = JSON.parse(JSON.stringify(documents[key]));
		expect(read(stored)).toEqual(expected);
	});
}

test("the seeded agent document names the own store on a private deployment, and the Foundry store otherwise", () => {
	const on = scopedEnv({ PRIVATE_NETWORKING: "True" });
	try {
		const seeded = configDocuments().agent as ReturnType<
			typeof defaultAgentSettings
		>;
		expect(seeded.memory.store).toBe("own");
		expect(parseAgentSettings(seeded, defaultAgentSettings())).toEqual(seeded);
	} finally {
		on();
	}
	const off = scopedEnv({ PRIVATE_NETWORKING: undefined });
	try {
		expect(
			(configDocuments().agent as { memory: { store: string } }).memory.store,
		).toBe("foundry");
	} finally {
		off();
	}
});

test("the seeded access document enforces readers on a hardened deployment, and keeps the demo's open default otherwise", () => {
	const on = scopedEnv({ HARDENED: "true" });
	try {
		const seeded = configDocuments().access;
		expect(seeded).toEqual({
			enforceAccessControl: true,
			globalDocumentAccess: true,
		});
		expect(seeded).toEqual(HARDENED_ACCESS_SETTINGS);
		expect(parseAccessSettings(seeded, defaultAccessSettings())).toEqual(
			HARDENED_ACCESS_SETTINGS,
		);
	} finally {
		on();
	}
	for (const demo of [undefined, "", "false"]) {
		const off = scopedEnv({ HARDENED: demo });
		try {
			expect(configDocuments().access).toEqual({
				enforceAccessControl: false,
				globalDocumentAccess: true,
			});
			expect(configDocuments().access).toEqual(DEFAULT_ACCESS_SETTINGS);
		} finally {
			off();
		}
	}
});

/** A store held in a map, as the service answers it: absent keys 404, an add of a present one 412. */
function mapStore(initial: Record<string, unknown>): Map<string, string> {
	const stored = new Map(
		Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
	);
	const status = (statusCode: number) =>
		Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
	setAppConfigClient({
		getConfigurationSetting: async ({ key }: { key: string }) => {
			const value = stored.get(key);
			if (value === undefined) throw status(404);
			return { key, value, etag: "1" };
		},
		addConfigurationSetting: async ({
			key,
			value,
		}: {
			key: string;
			value: string;
		}) => {
			if (stored.has(key)) throw status(412);
			stored.set(key, value);
			return { key, value };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	return stored;
}

test("a hardened deploy seeds enforcement where no access document is stored, and leaves one an operator stored as it is", async () => {
	const restore = scopedEnv({
		HARDENED: "true",
		APP_CONFIG_KEY_PREFIX: undefined,
	});
	try {
		const fresh = mapStore({});
		expect(await seedConfigDocuments(configDocuments())).toContain("access");
		expect(JSON.parse(fresh.get("app/access") ?? "null")).toEqual({
			enforceAccessControl: true,
			globalDocumentAccess: true,
		});
		resetAccessSettings();
		expect((await accessSettings()).enforceAccessControl).toBe(true);

		// An existing deployment, seeded before it was hardened or switched off by hand: the seed does not touch it.
		const operator = {
			enforceAccessControl: false,
			globalDocumentAccess: true,
		};
		const kept = mapStore({ "app/access": operator });
		expect(await seedConfigDocuments(configDocuments())).not.toContain(
			"access",
		);
		expect(JSON.parse(kept.get("app/access") ?? "null")).toEqual(operator);
		resetAccessSettings();
		expect((await accessSettings()).enforceAccessControl).toBe(false);
	} finally {
		resetAppConfigClient();
		resetAccessSettings();
		restore();
	}
});
