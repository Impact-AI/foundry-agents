import { expect, test } from "bun:test";
import { type EntityAliasTable, entitiesNamedIn } from "./entities";

/** A product's table: two cameras and an altimeter aboard a survey vessel. */
export const SURVEY_INSTRUMENTS: EntityAliasTable = [
	{
		tag: "nfc",
		name: "the vessel's Narrow Field Camera (NFC)",
		aliases: ["narrow field camera", "narrow camera", "nfc"],
	},
	{
		tag: "thermal",
		name: "the thermal imager",
		aliases: ["thermal imager", "thermal"],
	},
	{
		tag: "palt",
		name: "the Pulsed Altimeter (PALT)",
		aliases: ["pulsed altimeter", "altimeter", "palt"],
	},
];

test("an alias is matched on word boundaries, case-insensitively, not as a substring", () => {
	expect(
		entitiesNamedIn(SURVEY_INSTRUMENTS, "Based in Palterton").map((e) => e.tag),
	).toEqual([]);
	expect(
		entitiesNamedIn(SURVEY_INSTRUMENTS, "PALT ranged the seabed").map(
			(e) => e.tag,
		),
	).toEqual(["palt"]);
	expect(
		entitiesNamedIn(SURVEY_INSTRUMENTS, "how does the altimeter work?").map(
			(e) => e.tag,
		),
	).toEqual(["palt"]);
	expect(entitiesNamedIn([], "altimeter")).toEqual([]);
	expect(entitiesNamedIn(SURVEY_INSTRUMENTS, "")).toEqual([]);
});
