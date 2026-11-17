import { describe, expect, test } from "bun:test";
import { createTranslator } from "next-intl";
import { MEASURES } from "../../../backend/src/product/sample/records";
import { locales } from "../i18n/locales";
import {
	measureLabel,
	measureNames,
	namedChart,
	unitLabel,
} from "./measure-names";

const HERE = new URL(".", import.meta.url).pathname;

async function record(locale: string) {
	const messages = await Bun.file(
		`${HERE}../../messages/${locale}.json`,
	).json();
	return createTranslator({ locale, messages, namespace: "record" });
}

describe("a measure's name", () => {
	test("is the catalogue's, in the person's language, keyed by what the backend calls it", async () => {
		const en = await record("en");
		expect(measureLabel(en, "billableHours")).toBe("Billable hours");
		// The key is the data's spelling; the English name is not.
		expect(measureLabel(en, "utilisation")).toBe("Utilization");
		expect(unitLabel(en, "hours")).toBe("hours");
		const de = await record("de");
		expect(measureLabel(de, "billableHours")).toBe("Abrechenbare Stunden");
		expect(unitLabel(de, "hours")).toBe("Stunden");
	});

	test("falls back on the key in words, and a unit on itself, where the catalogue has none", async () => {
		const en = await record("en");
		expect(measureLabel(en, "netPromoterScore")).toBe("net promoter score");
		expect(measureLabel(en, "carbon_output")).toBe("carbon output");
		expect(measureLabel(en, "supportSLA")).toBe("support SLA");
		// A key that would be a path in the catalogue is never looked up as one.
		expect(measureLabel(en, "kinds.person")).toBe("kinds.person");
		expect(unitLabel(en, "kEUR")).toBe("kEUR");
		expect(unitLabel(en, "%")).toBe("%");
		expect(unitLabel(en, "litres")).toBe("litres");
	});

	test("is in every catalogue for every measure the sample keeps", async () => {
		for (const code of locales.codes) {
			const t = await record(code);
			for (const measures of Object.values(MEASURES))
				for (const { key, unit } of measures) {
					expect(t.has(`measureNames.${key}`)).toBe(true);
					if (/^[a-z]+$/.test(unit)) expect(t.has(`units.${unit}`)).toBe(true);
				}
		}
	});
});

describe("a measure's chart, named", () => {
	test("is titled for its record and the measure's name, its unit in the person's language", async () => {
		const names = measureNames(await record("fr"));
		const chart = namedChart(
			{
				title: "Ada Quill — billable hours",
				unit: "hours",
				series: [{ name: "Ada Quill", points: [{ x: "2024-Q1", y: 410 }] }],
			},
			"billableHours",
			names,
		);
		expect(chart.title).toBe("Ada Quill — Heures facturables");
		expect(chart.unit).toBe("heures");
		expect(chart.series).toHaveLength(1);
	});

	test("keeps a title it cannot name a record in, and adds no unit", async () => {
		const names = measureNames(await record("en"));
		const two = {
			title: "Two of them",
			series: [
				{ name: "A", points: [{ x: "1", y: 1 }] },
				{ name: "B", points: [{ x: "1", y: 2 }] },
			],
		};
		expect(namedChart(two, "spend", names)).toEqual(two);
	});
});
