import { describe, expect, test } from "bun:test";
import { SURVEY_INSTRUMENTS } from "./entities.test";
import { filterableSignal, selectiveTags } from "./signal";
import type { TagCount } from "./vocabulary";

/**
 * The gate's two errors cost different things, so the cases run in both
 * directions, and the "spared" group is the one that matters: every question
 * in it would otherwise cost a model call for an empty spec.
 */

const VOCAB: TagCount[] = [
	{ tag: "survey", count: 1191 },
	{ tag: "social", count: 564 },
	{ tag: "team", count: 556 },
	{ tag: "reference", count: 507 },
	{ tag: "orca", count: 170 },
	{ tag: "agency", count: 168 },
	{ tag: "team-engineering", count: 137 },
	{ tag: "dispatch", count: 53 },
	{ tag: "nfc", count: 25 },
	{ tag: "thermal", count: 19 },
	{ tag: "headland", count: 11 },
];

const subjectTags = ["orca"];
const signal = (q: string) =>
	filterableSignal(q, VOCAB, { entities: SURVEY_INSTRUMENTS, subjectTags });
const terms = (q: string) => signal(q).map((m) => m.term);

describe("a tag only counts if it narrows anything", () => {
	test("the commonest tag is not selective; a rare one is", () => {
		const kept = selectiveTags(VOCAB, subjectTags).map((t) => t.tag);
		expect(kept).not.toContain("survey");
		expect(kept).toContain("nfc");
		expect(kept).toContain("headland");
		expect(terms("tell me about the survey")).toEqual([]);
	});

	test("a vocabulary with no counts judges nothing and lets everything through", () => {
		expect(
			filterableSignal("about the survey", [{ tag: "survey", count: 0 }]),
		).toHaveLength(1);
	});
});

describe("questions the planner is spared", () => {
	test("a topic, a person, a how-does-it-work, a date, an empty question", () => {
		expect(terms("tell me about the vessel's radar")).toEqual([]);
		expect(terms("who is the skipper?")).toEqual([]);
		expect(terms("how does the vessel navigate on its own?")).toEqual([]);
		// The index holds no date a filter could act on, so a period is a topic.
		expect(terms("what happened in July 2025?")).toEqual([]);
		expect(terms("")).toEqual([]);
		expect(terms("   ...?  ")).toEqual([]);
	});
});

describe("questions that earn the call", () => {
	test("a request for pictures, a selective tag", () => {
		expect(signal("show me some NFC images").map((m) => m.kind)).toContain(
			"media",
		);
		expect(terms("show me some NFC images")).toContain("nfc");
		expect(
			terms("can you show me pictures the narrow field camera took?"),
		).toContain("picture");
	});

	test("an English plural is matched from the singular; a hyphenated tag as the words people write", () => {
		expect(terms("show me the photographs")).toContain("photograph");
		expect(terms("who works in team engineering?")).toContain(
			"team-engineering",
		);
	});
});

describe("all five languages, because the gate must not fail silently", () => {
	test("a request for pictures", () => {
		expect(terms("mostrami delle immagini")).toContain("immagini");
		expect(terms("muéstrame las imágenes")).toContain("imágenes");
		expect(terms("montre-moi des photographies")).toContain("photographie");
		expect(terms("zeig mir die Bilder")).toContain("bilder");
	});
});

describe("matching is on whole words", () => {
	test("a term inside a longer word is not a match; punctuation and case do not hide one", () => {
		expect(terms("the imagery pipeline")).toEqual([]);
		expect(terms("teamwork makes the dream work")).toEqual([]);
		expect(terms("NFC, images?")).toContain("nfc");
		expect(terms("(images)")).toContain("image");
	});
});

describe("the corpus's own name carries no intent", () => {
	test("a subject tag is not signal however selective it looks, whoever named it, and case does not hide one", () => {
		expect(selectiveTags(VOCAB, subjectTags).map((t) => t.tag)).not.toContain(
			"orca",
		);
		expect(terms("what is orca?")).toEqual([]);
		expect(terms("show me orca images")).toContain("image");
		expect(selectiveTags(VOCAB, subjectTags).map((t) => t.tag)).toContain(
			"agency",
		);
		const named = selectiveTags(VOCAB, ["agency", " Dispatch "]).map(
			(t) => t.tag,
		);
		expect(named).not.toContain("agency");
		expect(named).not.toContain("dispatch");
	});

	test("the selectivity is the caller's: a stricter fraction keeps fewer tags", () => {
		expect(selectiveTags(VOCAB, [], 0.5).map((t) => t.tag)).toContain("social");
		expect(selectiveTags(VOCAB, [], 0.1).map((t) => t.tag)).not.toContain(
			"social",
		);
		expect(
			filterableSignal("any social notes?", VOCAB, { tagSelectivity: 0.1 }).map(
				(m) => m.term,
			),
		).not.toContain("social");
	});
});

describe("an entity named without its tag is still signal", () => {
	const withAltimeter = [...VOCAB, { tag: "palt", count: 11 }];
	const named = (q: string) =>
		filterableSignal(q, withAltimeter, {
			entities: SURVEY_INSTRUMENTS,
			subjectTags,
		}).map((m) => m.term);

	test("a bare word or a spelled-out name reaches its tag; word boundaries hold", () => {
		expect(named("how does the altimeter work?")).toContain("palt");
		expect(named("what did the narrow field camera see?")).toContain("nfc");
		expect(named("what does the thermal imager measure?")).toContain("thermal");
		expect(named("who is based in Palterton?")).toEqual([]);
	});

	test("an entity the corpus carries nothing for is not worth planning", () => {
		expect(terms("how does the altimeter work?")).toEqual([]);
	});
});

test("the gate can be switched off, and then every question is planned", () => {
	expect(
		filterableSignal("hello", VOCAB, { gate: false }).map((m) => m.term),
	).toEqual(["*gate-disabled*"]);
	expect(terms("hello")).toEqual([]);
});

test("tags used about as often as one another are all signal: a cutoff that would admit none excludes none", () => {
	const even: TagCount[] = [
		{ tag: "finance", count: 40 },
		{ tag: "people", count: 30 },
		{ tag: "operations", count: 25 },
	];
	expect(selectiveTags(even, [], 0.5).map((t) => t.tag)).toEqual([
		"finance",
		"people",
		"operations",
	]);
	expect(
		filterableSignal("what is our finance calendar", even, {
			tagSelectivity: 0.5,
		}),
	).toEqual([{ kind: "tag", term: "finance" }]);
});

test("an entity's lowercase tag reaches the index's own spelling of it", () => {
	const vocabulary: TagCount[] = [
		{ tag: "Depot", count: 3 },
		{ tag: "general", count: 90 },
	];
	const entities = [
		{ tag: "depot", name: "the North Depot", aliases: ["north yard"] },
	];
	expect(
		filterableSignal("who runs the north yard", vocabulary, { entities }),
	).toEqual([{ kind: "tag", term: "Depot" }]);
});
