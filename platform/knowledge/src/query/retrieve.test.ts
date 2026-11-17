import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resetAccessSettings } from "../config/access";
import { stagedAccessSettings } from "../testing/fake-config";
import type { SearchHit } from "../types";
import type { QueryPlan } from "./draft";
import { retrieve } from "./retrieve";
import type { SearchOptions } from "./search";

/**
 * The ladder against a recorded search: which constraints were dropped to
 * get rows, and whether the caller is told. Rows reported with an empty
 * `relaxed` are ones a caller may describe in the words of the filter.
 */

function hit(documentId: string, text = "some passage"): SearchHit {
	return {
		documentId,
		path: `lib/${documentId}.png`,
		kind: "picture",
		chunkId: `${documentId}_pages_0`,
		score: 1,
		rerankerScore: 2.5,
		title: documentId,
		summary: "",
		text,
		tags: [],
	};
}

function fullPlan(): QueryPlan {
	return {
		searchText: '"narrow field camera" headland',
		semanticQuery: "show me NFC images",
		spec: { tags: ["nfc"], kinds: ["picture"] },
		source: "model",
	};
}

/** Answers on the nth call and returns nothing before it; records what it was sent. */
function searchAnsweringOn(n: number, answer = [hit("a")]) {
	const calls: SearchOptions[] = [];
	const search = async (opts: SearchOptions) => {
		calls.push(opts);
		return calls.length === n ? answer : [];
	};
	return { calls, search };
}

afterEach(() => {
	resetAccessSettings();
});

describe("a plan with no filters never climbs the ladder", () => {
	test("one query, nothing relaxed, both strings sent", async () => {
		const { calls, search } = searchAnsweringOn(1);
		const out = await retrieve("tell me about the radar", {
			plan: {
				searchText: "radar",
				semanticQuery: "tell me about the radar",
				spec: {},
				source: "model",
			},
			search,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.searchText).toBe("radar");
		expect(calls[0]?.query).toBe("tell me about the radar");
		expect(out.relaxed).toEqual([]);
		expect(out.hits).toHaveLength(1);
	});
});

describe("the ladder relaxes in order and reports what it dropped", () => {
	const question = "show me NFC images";

	test("the full plan answering means nothing was relaxed", async () => {
		const { calls, search } = searchAnsweringOn(1);
		const out = await retrieve(question, { plan: fullPlan(), search });
		expect(out.relaxed).toEqual([]);
		expect(calls[0]?.tags).toEqual(["nfc"]);
		expect(calls[0]?.kinds).toEqual(["picture"]);
	});

	test("the tags first, the kinds last, and three queries at most", async () => {
		const second = searchAnsweringOn(2);
		expect(
			(await retrieve(question, { plan: fullPlan(), search: second.search }))
				.relaxed,
		).toEqual(["tags"]);
		expect(second.calls[1]?.tags).toBeUndefined();
		expect(second.calls[1]?.kinds).toEqual(["picture"]);

		const third = searchAnsweringOn(3);
		expect(
			(await retrieve(question, { plan: fullPlan(), search: third.search }))
				.relaxed,
		).toEqual(["tags", "kinds"]);
		expect(third.calls[2]?.kinds).toBeUndefined();

		const never = searchAnsweringOn(99);
		const out = await retrieve(question, {
			plan: fullPlan(),
			search: never.search,
		});
		expect(never.calls).toHaveLength(3);
		expect(out.hits).toEqual([]);
		expect(out.relaxed).toEqual(["tags", "kinds"]);
	});

	test("only the constraints a plan actually had can be relaxed", async () => {
		const kindsOnly = searchAnsweringOn(2);
		const out = await retrieve("pictures", {
			plan: {
				searchText: "pictures",
				semanticQuery: "pictures",
				spec: { kinds: ["picture"] },
				source: "model",
			},
			search: kindsOnly.search,
		});
		expect(kindsOnly.calls).toHaveLength(2);
		expect(out.relaxed).toEqual(["kinds"]);

		const tagsOnly = searchAnsweringOn(2);
		expect(
			(
				await retrieve("NFC notes", {
					plan: {
						searchText: "NFC",
						semanticQuery: "NFC notes",
						spec: { tags: ["nfc"] },
						source: "model",
					},
					search: tagsOnly.search,
				})
			).relaxed,
		).toEqual(["tags"]);
	});
});

describe("the readers clause is not a rung", () => {
	const caller = { oid: "p-1", groups: ["g-1"] };

	test("every rung of the ladder carries the caller unchanged, the unfiltered last one included", async () => {
		const never = searchAnsweringOn(99);
		const out = await retrieve("show me NFC images", {
			plan: fullPlan(),
			search: never.search,
			access: caller,
		});
		expect(never.calls).toHaveLength(3);
		for (const call of never.calls) expect(call.access).toBe(caller);
		expect(never.calls[2]?.tags).toBeUndefined();
		expect(out.refused).toBeNull();
	});

	test("with enforcement on and nobody asking, no search runs and the refusal is named", async () => {
		const restore = stagedAccessSettings({ enforceAccessControl: true });
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const { calls, search } = searchAnsweringOn(1);
			const out = await retrieve("anything", {
				plan: fullPlan(),
				search,
				access: null,
			});
			expect(calls).toHaveLength(0);
			expect(out).toMatchObject({
				hits: [],
				relaxed: [],
				refused: "unidentified_caller",
			});
			expect(error).toHaveBeenCalledTimes(1);
			const seen = await retrieve("anything", {
				plan: fullPlan(),
				search,
				access: caller,
			});
			expect(seen.refused).toBeNull();
			expect(calls).toHaveLength(1);
		} finally {
			error.mockRestore();
			restore();
		}
	});
});

describe("a search that missed still answers, and says which words it never found", () => {
	test("unmatched terms ride on every result", async () => {
		const { search } = searchAnsweringOn(1, [
			hit("a", "the thermal imager read surface heat"),
		]);
		const out = await retrieve("show me NFC images of the headland", {
			plan: {
				searchText: "nfc headland",
				semanticQuery: "show me NFC images of the headland",
				spec: {},
				source: "model",
			},
			search,
		});
		expect(out.unmatchedTerms).toEqual(["nfc", "headland"]);
		const empty = await retrieve("anything", {
			plan: {
				searchText: "anything",
				semanticQuery: "anything",
				spec: {},
				source: "model",
			},
			search: async () => [],
		});
		expect(empty.unmatchedTerms).toEqual([]);
	});
});
