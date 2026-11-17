import { expect, test } from "bun:test";
import { humanizeMeasure } from "./measure-name";
import { series } from "./sample/metrics";
import { findRecord } from "./sample/records";

test("a measure's key reads as words: camel case and separators split, an acronym kept whole", () => {
	expect(humanizeMeasure("spend")).toBe("spend");
	expect(humanizeMeasure("billableHours")).toBe("billable hours");
	expect(humanizeMeasure("running_cost")).toBe("running cost");
	expect(humanizeMeasure("support-tickets")).toBe("support tickets");
	expect(humanizeMeasure("supportSLA")).toBe("support SLA");
	expect(humanizeMeasure("SLAMisses")).toBe("SLA misses");
	expect(humanizeMeasure("q4Revenue")).toBe("q4 revenue");
});

test("a chart's title names the measure in words, never by its key", () => {
	const mara = findRecord("person", "mara-lindqvist");
	if (!mara) throw new Error("no sample person");
	expect(series(mara, "billableHours")?.title).toBe(
		"Mara Lindqvist — billable hours",
	);
});
