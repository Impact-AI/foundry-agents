import { expect, test } from "bun:test";
import { CHIP_COUNT, planChips } from "./suggestions";

test("three authored asks are the row, verbatim", () => {
	expect(
		planChips({ authored: ["a", "b", "c", "d"], empty: false, sections: [] }),
	).toEqual({
		authored: ["a", "b", "c"],
		keys: [],
	});
});

test("an empty thread is filled with openers and a door", () => {
	const plan = planChips({ authored: [], empty: true, sections: [] });
	expect(plan.authored).toEqual([]);
	expect(plan.keys).toEqual(["library", "record"]);
	expect(plan.keys.length).toBeLessThanOrEqual(CHIP_COUNT);
});

test("after a turn the fallbacks follow what is on the stage, then a door out", () => {
	const plan = planChips({
		authored: [" One "],
		empty: false,
		sections: ["reader"],
	});
	expect(plan).toEqual({
		authored: ["One"],
		keys: ["summarise", "relatedRecords"],
	});
	const full = planChips({
		authored: [],
		empty: false,
		sections: ["library", "chart"],
	});
	expect(full.keys).toEqual(["openFirst", "narrowLibrary", "explainChart"]);
	// A listing's follow-ups are the openers a record and a chart answer, with the library as the door.
	expect(
		planChips({ authored: [], empty: false, sections: ["records"] }).keys,
	).toEqual(["record", "chart", "library"]);
	const doored = planChips({
		authored: ["x", "y"],
		empty: false,
		sections: ["chart"],
	});
	expect(doored.keys).toEqual(["explainChart"]);
});
