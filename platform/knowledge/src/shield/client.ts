import {
	processSingleton,
	resetSingleton,
	setSingleton,
} from "@platform/config";
import {
	cognitiveServicesToken,
	providerFetch,
	withRetries,
} from "@platform/llm";
import { APICallError } from "ai";
import { aiServicesUrl } from "../index/embedding";

/**
 * Prompt Shields, asked whether text that will reach a model as a tool's
 * output carries an attack on it. The library's text reaches the model as
 * a function tool's output, which Foundry's guardrail does not scan, so the
 * job asks once per chunk at ingest, as `documents`, on the Foundry account
 * under the job's identity. No Content Safety resource of its own: the
 * account's whole data plane is Cognitive Services User, which the job
 * holds.
 */
export interface Shield {
	/** For each text, in order: whether an attack was detected in it. */
	scan(documents: readonly string[]): Promise<boolean[]>;
}

const API_VERSION = "2024-09-01";

interface ShieldAnswer {
	documentsAnalysis?: { attackDetected?: boolean }[];
}

/** The account's `text:shieldPrompt`, keyless, through the bounded retry every model call has. */
export function azureShield(): Shield {
	return {
		async scan(documents) {
			if (documents.length === 0) return [];
			const url = `${aiServicesUrl()}contentsafety/text:shieldPrompt?api-version=${API_VERSION}`;
			const body = JSON.stringify({ documents });
			const answer = await withRetries(async () => {
				const res = await providerFetch()(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${await cognitiveServicesToken()}`,
						"content-type": "application/json",
					},
					body,
				});
				const text = await res.text();
				if (!res.ok)
					throw new APICallError({
						message: `Prompt Shields answered ${res.status}: ${text.slice(0, 300)}`,
						url,
						requestBodyValues: {},
						statusCode: res.status,
						responseHeaders: Object.fromEntries(res.headers),
						responseBody: text,
						isRetryable: res.status === 429 || res.status >= 500,
					});
				return JSON.parse(text) as ShieldAnswer;
			});
			const analysis = answer.documentsAnalysis ?? [];
			if (analysis.length !== documents.length)
				throw new Error(
					`Prompt Shields answered for ${analysis.length} of ${documents.length} documents`,
				);
			return analysis.map((a) => a.attackDetected === true);
		},
	};
}

const SHIELD = "knowledge:shield";

/** The shield this process asks: the account's, unless a test wired another. */
export function shield(): Shield {
	return processSingleton(SHIELD, azureShield);
}

export function wireShield(replacement: Shield): void {
	setSingleton(SHIELD, replacement);
}

export function resetShield(): void {
	resetSingleton(SHIELD);
}
