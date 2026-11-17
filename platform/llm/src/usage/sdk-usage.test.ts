import { expect, test } from "bun:test";
import { finishReason, tokenCounts } from "./sdk-usage";

/** A nested (v4) usage block, which is what the installed provider returns. */
const NESTED = {
	inputTokens: { total: 17_400, noCache: 12_800, cacheRead: 4_600 },
	outputTokens: { total: 380, text: 300, reasoning: 80 },
};

test("a nested block is read field by field; a missing one is null; the total is left to the line", () => {
	expect(tokenCounts(NESTED)).toEqual({
		inputTokens: 17_400,
		outputTokens: 380,
		totalTokens: null,
		reasoningTokens: 80,
		cachedInputTokens: 4_600,
	});
	expect(tokenCounts({ inputTokens: { total: 100 } })).toMatchObject({
		inputTokens: 100,
		outputTokens: null,
		reasoningTokens: null,
		cachedInputTokens: null,
	});
	expect(tokenCounts(undefined)).toEqual({
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		reasoningTokens: null,
		cachedInputTokens: null,
	});
});

test("a flat block is read as well, a reported total passes through, and junk is null", () => {
	expect(
		tokenCounts({
			inputTokens: 90,
			outputTokens: 10,
			totalTokens: 111,
			cachedInputTokens: 30,
			reasoningTokens: "junk",
		}),
	).toEqual({
		inputTokens: 90,
		outputTokens: 10,
		totalTokens: 111,
		reasoningTokens: null,
		cachedInputTokens: 30,
	});
});

test("the unified finish reason wins, a bare string is kept, anything else is unknown", () => {
	expect(finishReason({ unified: "stop", raw: "completed" })).toBe("stop");
	expect(finishReason("length")).toBe("length");
	expect(finishReason({ raw: "x" })).toBe("unknown");
	expect(finishReason(undefined)).toBe("unknown");
});
