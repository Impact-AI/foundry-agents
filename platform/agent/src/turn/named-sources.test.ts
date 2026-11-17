import { expect, test } from "bun:test";
import { namedSources } from "./named-sources";

const van = { id: "van", title: "Van guide" };
const depot = { id: "depot", title: "Depot checklist" };
const tablet = { id: "tablet", title: "Tablet plan" };
const all = [van, depot, tablet];

test("of three candidates, the one the reply names is the chip", () => {
	expect(
		namedSources("The van guide says to check the tyres first.", all),
	).toEqual([van]);
});

test("a reply that names none keeps every candidate", () => {
	expect(namedSources("Check the tyres first.", all)).toEqual(all);
});

test("a title written with markdown emphasis around it still matches", () => {
	expect(namedSources("See the **Van guide** for the tyres.", all)).toEqual([
		van,
	]);
	expect(namedSources("See the _Depot Checklist_ for the keys.", all)).toEqual([
		depot,
	]);
});

test("more than one named is more than one chip, in the candidates' order", () => {
	expect(
		namedSources("The tablet plan and the van guide both say so.", all),
	).toEqual([van, tablet]);
});

test("a candidate with no title cannot be named, and nothing named keeps it with the rest", () => {
	const untitled = { id: "x", title: "" };
	expect(namedSources("Anything at all.", [untitled, van])).toEqual([
		untitled,
		van,
	]);
	expect(namedSources("The van guide.", [untitled, van])).toEqual([van]);
});
