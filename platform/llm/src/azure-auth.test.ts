import { afterEach, expect, test } from "bun:test";
import type { TokenCredentialLike } from "@platform/config";
import {
	azureOpenAI,
	COGNITIVE_SERVICES_SCOPE,
	cognitiveServicesToken,
	createCognitiveServicesTokenProvider,
} from "./azure-auth";
import { ModelNotConfiguredError } from "./model-roles";
import { completion, configure, fakeAzure } from "./testing";

let restore = () => {};

afterEach(() => restore());

/** A credential that hands out numbered tokens and records what it was asked for. */
function fakeCredential(now: () => number) {
	const state = { calls: 0, scopes: [] as string[] };
	const credential: TokenCredentialLike = {
		async getToken(scopes) {
			state.calls += 1;
			state.scopes.push(Array.isArray(scopes) ? scopes.join(" ") : scopes);
			return {
				token: `token-${state.calls}`,
				expiresOnTimestamp: now() + 3_600_000,
			};
		},
	};
	return { credential, state };
}

test("the provider asks for the Cognitive Services scope and caches the answer", async () => {
	let clock = 1_000_000;
	const { credential, state } = fakeCredential(() => clock);
	const token = createCognitiveServicesTokenProvider({
		credential: () => credential,
		now: () => clock,
	});

	expect(await token()).toBe("token-1");
	clock += 60_000;
	expect(await token()).toBe("token-1");
	expect(state.calls).toBe(1);
	expect(state.scopes).toEqual([COGNITIVE_SERVICES_SCOPE]);
});

test("a burst of callers shares one mint", async () => {
	const { credential, state } = fakeCredential(() => 0);
	const token = createCognitiveServicesTokenProvider({
		credential: () => credential,
		now: () => 0,
	});
	const tokens = await Promise.all(Array.from({ length: 8 }, () => token()));
	expect(tokens).toEqual(Array(8).fill("token-1"));
	expect(state.calls).toBe(1);
});

test("a credential that yields nothing names the role to grant", async () => {
	const token = createCognitiveServicesTokenProvider({
		credential: () => ({ getToken: async () => null }),
	});
	await expect(token()).rejects.toThrow(/Cognitive Services OpenAI User/);
});

test("the process token comes from the process's one credential", async () => {
	restore = configure();
	expect(await cognitiveServicesToken()).toBe("token-1");
});

test("no account means a typed refusal before any provider is built", () => {
	restore = configure();
	expect(() => azureOpenAI()).toThrow(ModelNotConfiguredError);
	try {
		azureOpenAI();
	} catch (err) {
		expect((err as ModelNotConfiguredError).role).toBe("account");
	}
});

test("every request carries the Entra token as a bearer, and no key", async () => {
	restore = configure({ AZURE_OPENAI_RESOURCE_NAME: "account-eu" });
	const { requests } = fakeAzure(() => completion("ok"));

	const result = await azureOpenAI()
		.responses("chat-eu")
		.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		});

	expect(result.content).toMatchObject([{ type: "text", text: "ok" }]);
	const [request] = requests;
	expect(request?.url).toStartWith(
		"https://account-eu.openai.azure.com/openai/v1/responses",
	);
	expect(request?.headers.authorization).toBe("Bearer token-1");
	expect(request?.headers["api-key"]).toBeUndefined();
	expect(request?.body.model).toBe("chat-eu");
});
