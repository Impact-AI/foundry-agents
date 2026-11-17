import { expect, test } from "bun:test";
import {
	citationMarkerFilter,
	withoutCitationMarkers,
} from "./citation-markers";

const through = (deltas: string[]) => {
	const filter = citationMarkerFilter();
	return deltas.map((d) => filter.push(d)).join("") + filter.flush();
};

test("a citation marker leaves the text, whole or split across deltas", () => {
	expect(through(["It is 9°C. 【6:0†source】 Bring a coat."])).toBe(
		"It is 9°C.  Bring a coat.",
	);
	expect(through(["It is 9°C. 【", "6:0†sou", "rce】", " Bring a coat."])).toBe(
		"It is 9°C.  Bring a coat.",
	);
});

test("a bracket that is no marker is kept, and nothing is held past the end", () => {
	expect(through(["a 【note】 b"])).toBe("a 【note】 b");
	expect(through(["ends on 【"])).toBe("ends on 【");
});

test("an answer read back from the conversation carries no marker", () => {
	expect(withoutCitationMarkers("A passkey. 【12:0†source】")).toBe(
		"A passkey. ",
	);
});

test("the model's own marker, private-use characters around a passage id, leaves the text whole or split", () => {
	const id = "a8abafe87016e213e46dbf3820ee6689:0";
	expect(through([`It is checked at noon. cite${id}`])).toBe(
		"It is checked at noon. ",
	);
	expect(
		through(["Noon. ci", `te${id.slice(0, 9)}`, `${id.slice(9)} Done.`]),
	).toBe("Noon.  Done.");
	expect(withoutCitationMarkers(`Noon.cite${id}`)).toBe("Noon.");
});
