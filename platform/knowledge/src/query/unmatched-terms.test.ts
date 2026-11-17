import { expect, test } from "bun:test";
import { type SearchableHit, unmatchedQueryTerms } from "./unmatched-terms";

/**
 * As much about what must not be reported as what must: a false positive
 * makes the agent disown what it holds, so every case returning `[]` guards
 * that direction.
 */

/** A thermal-imager dispatch, near enough to any question about the pass to outrank the camera's. */
const thermalHit: SearchableHit = {
	title: "The headland in the mid-infrared",
	summary: "Dispatch, 2025-03-13",
	text: "The thermal imager reads surface heat instead of reflected light. The crew saw these images the day after we passed. Range to the headland: 1000 m.",
	tags: ["survey", "dispatch", "thermal"],
};

test("a term the corpus has never heard of is reported, and the term that matched is not", () => {
	expect(unmatchedQueryTerms("nfc images", [thermalHit])).toEqual(["nfc"]);
	expect(unmatchedQueryTerms("nfc headland thermal", [thermalHit])).toEqual([
		"nfc",
	]);
	expect(unmatchedQueryTerms("headland thermal imager", [thermalHit])).toEqual(
		[],
	);
});

test("no hits reports nothing rather than the whole query", () => {
	expect(unmatchedQueryTerms("nfc images", [])).toEqual([]);
});

test("asking to be shown a thing is not a claim about the archive", () => {
	expect(
		unmatchedQueryTerms("show me some pictures please", [thermalHit]),
	).toEqual([]);
});

test("a plural finds its singular and a singular its plural", () => {
	expect(
		unmatchedQueryTerms("cameras", [{ text: "the narrow camera opened" }]),
	).toEqual([]);
	expect(
		unmatchedQueryTerms("camera", [{ text: "the Narrow Field Cameras" }]),
	).toEqual([]);
});

test("function words in the other four languages are not reported", () => {
	const hit: SearchableHit = {
		text: "il sensore termico ha misurato il calore",
	};
	expect(
		unmatchedQueryTerms("mostrami delle immagini del termico", [hit]),
	).toEqual([]);
	expect(
		unmatchedQueryTerms("muéstrame algunas fotos del termico", [hit]),
	).toEqual([]);
	expect(
		unmatchedQueryTerms("montrez-moi des photos du termico", [hit]),
	).toEqual([]);
	expect(
		unmatchedQueryTerms("zeig mir einige Bilder von termico", [hit]),
	).toEqual([]);
});

test("accented words are tokenised whole", () => {
	const hit: SearchableHit = { text: "Michael Küppers, project scientist" };
	expect(unmatchedQueryTerms("Küppers", [hit])).toEqual([]);
	expect(unmatchedQueryTerms("Kröger", [hit])).toEqual(["kröger"]);
});

test("a term found only in a document's description, or in any one hit, counts as found", () => {
	expect(
		unmatchedQueryTerms("palt", [{ text: "nothing here", tags: ["palt"] }]),
	).toEqual([]);
	expect(
		unmatchedQueryTerms("palt", [
			{ text: "nothing here", summary: "the PALT ranged" },
		]),
	).toEqual([]);
	expect(
		unmatchedQueryTerms("nfc", [
			thermalHit,
			{ text: "the Narrow Field Camera (NFC)" },
		]),
	).toEqual([]);
});

test("the report is capped and each term appears once", () => {
	expect(
		unmatchedQueryTerms("alpha bravo alpha charlie delta echo foxtrot", [
			{ text: "unrelated prose" },
		]),
	).toEqual(["alpha", "bravo", "charlie", "delta"]);
});
