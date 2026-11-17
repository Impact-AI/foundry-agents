import { describe, expect, test } from "bun:test";
import {
	fallbackPlan,
	planHasFilters,
	type QueryDraft,
	sanitizeSearchText,
	validateDraft,
} from "./draft";
import type { TagCount } from "./vocabulary";

/**
 * The planner's judgement without a model. The draft is written by hand,
 * because `validateDraft` is the part that can be quietly wrong: every claim
 * it lets through wrongly is a search that narrows to nothing while looking
 * like it worked.
 */

const VOCAB: TagCount[] = [
	{ tag: "nfc", count: 12 },
	{ tag: "thermal", count: 7 },
	{ tag: "headland", count: 40 },
	{ tag: "dispatch", count: 90 },
];

function plan(draft: QueryDraft, question = "a question") {
	return validateDraft(draft, question, VOCAB);
}

describe("tags are gated on the corpus", () => {
	test("a known tag is kept; an invented one is dropped and named; a wholly invented list is no filter", () => {
		expect(plan({ tags: ["nfc"] }).spec.tags).toEqual(["nfc"]);
		const p = plan({ tags: ["nfc", "vessel", "imagery"] });
		expect(p.spec.tags).toEqual(["nfc"]);
		expect(p.unknownTags).toEqual(["vessel", "imagery"]);
		const none = plan({ tags: ["photos", "coastal-imagery"] });
		expect(none.spec.tags).toBeUndefined();
		expect(planHasFilters(none)).toBe(false);
	});

	test("case-folded and de-duplicated", () => {
		expect(plan({ tags: ["NFC", "THERMAL"] }).spec.tags).toEqual([
			"nfc",
			"thermal",
		]);
		expect(plan({ tags: ["nfc", "NFC", " nfc "] }).spec.tags).toEqual(["nfc"]);
	});

	test("tagMode 'all' applies only with more than one surviving tag, and an unreadable one is the default", () => {
		expect(
			plan({ tags: ["nfc", "headland"], tagMode: "all" }).spec.tagMode,
		).toBe("all");
		expect(
			plan({ tags: ["nfc", "nonsense"], tagMode: "all" }).spec.tagMode,
		).toBeUndefined();
		expect(
			plan({ tags: ["nfc", "thermal"], tagMode: "ALL" }).spec.tagMode,
		).toBe("all");
		expect(
			plan({ tags: ["nfc", "thermal"], tagMode: "both" }).spec.tagMode,
		).toBeUndefined();
	});
});

describe("the crafted search text is made safe for the query syntax", () => {
	test("a balanced phrase quote survives; an unbalanced one goes; operators and a leading hyphen go", () => {
		expect(sanitizeSearchText('"Narrow Field Camera" headland', "q")).toBe(
			'"Narrow Field Camera" headland',
		);
		expect(sanitizeSearchText('"Narrow Field Camera headland', "q")).toBe(
			"Narrow Field Camera headland",
		);
		expect(sanitizeSearchText("nfc +images | video*", "q")).toBe(
			"nfc images video",
		);
		expect(sanitizeSearchText("-headland north-south", "q")).toBe(
			"headland north-south",
		);
	});

	test("text that sanitises to nothing falls back to the question; a long text is cut on a word and left balanced", () => {
		expect(sanitizeSearchText("*** (|) ***", "what did the imager see")).toBe(
			"what did the imager see",
		);
		expect(sanitizeSearchText("", "what did the imager see")).toBe(
			"what did the imager see",
		);
		const out = sanitizeSearchText(`${'"a phrase" '.repeat(200)}tail`, "q");
		expect(out.length).toBeLessThanOrEqual(400);
		expect((out.match(/"/g) ?? []).length % 2).toBe(0);
	});

	test("the reranker always gets the question, whatever the keywords are", () => {
		const p = validateDraft(
			{ searchText: "nfc headland" },
			"can you show me what the narrow camera saw?",
			VOCAB,
		);
		expect(p.searchText).toBe("nfc headland");
		expect(p.semanticQuery).toBe("can you show me what the narrow camera saw?");
	});
});

describe("the fallback and the empty draft", () => {
	test("question in, question out, no filters, source reported", () => {
		const p = fallbackPlan("  what is the radar  ", "unavailable");
		expect(p).toMatchObject({
			searchText: "what is the radar",
			semanticQuery: "what is the radar",
			source: "unavailable",
		});
		expect(planHasFilters(p)).toBe(false);
	});

	test("a question searched as typed carries no operator into the lexical arm, and is cut like a draft; the reranker still gets it whole", () => {
		const p = fallbackPlan('-refunds "open quote * (policy)?', "unfiltered");
		expect(p.searchText).toBe("refunds open quote policy");
		expect(p.semanticQuery).toBe('-refunds "open quote * (policy)?');
		const long = fallbackPlan("word ".repeat(400), "capacity");
		expect(long.searchText.length).toBeLessThanOrEqual(400);
		expect(sanitizeSearchText("***", "-what +did the imager see?")).toBe(
			"what did the imager see",
		);
	});

	test("most questions plan to nothing, from the model", () => {
		const p = validateDraft(
			{ searchText: "vessel radar" },
			"tell me about the vessel's radar",
			VOCAB,
		);
		expect(p.spec).toEqual({});
		expect(p.source).toBe("model");
	});
});

describe("a kind filter has to narrow to be worth having", () => {
	test("pictures asked for are a filter; a bad member costs itself alone, beside a tag that stands", () => {
		expect(plan({ kinds: ["picture"] }).spec.kinds).toEqual(["picture"]);
		expect(plan({ kinds: ["Pictures", "PICTURE"] }).spec.kinds).toEqual([
			"picture",
		]);
		const near = plan({ kinds: ["images", "picture"], tags: ["nfc"] });
		expect(near.spec).toEqual({ tags: ["nfc"], kinds: ["picture"] });
	});

	test("a lone document is the model filling in a box, and both kinds exclude nothing: neither is a filter", () => {
		const p = plan({ kinds: ["document"] });
		expect(p.spec.kinds).toBeUndefined();
		expect(planHasFilters(p)).toBe(false);
		expect(plan({ kinds: ["document", "picture"] }).spec.kinds).toBeUndefined();
		expect(plan({ kinds: ["video"] }).spec.kinds).toBeUndefined();
	});
});
