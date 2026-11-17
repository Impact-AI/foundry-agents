import { describe, expect, test } from "bun:test";
import { appearanceDefaults } from "@platform/appearance";
import en from "../../messages/en.json";
import { withBrand } from "./brand";
import { locales } from "./locales";

const brand = appearanceDefaults(locales.codes).brand;

describe("the deployment's name and welcome line", () => {
	test("leave the catalogue as it is when none is set", () => {
		expect(withBrand(en, brand, "en")).toEqual(en);
	});

	test("are the app's name, the page's title and the workspace's heading, in their language only", () => {
		const set = {
			...brand,
			name: { ...brand.name, en: "Helper" },
			welcome: { ...brand.welcome, en: "Good morning." },
		};
		const out = withBrand(en, set, "en");
		expect(out.common.appName).toBe("Helper");
		expect(out.metadata.title).toBe("Helper");
		expect(out.landing.heading).toBe("Good morning.");
		expect(out.ai).toEqual(en.ai);
		expect(withBrand(en, set, "it")).toEqual(en);
	});

	test("land on keys every catalogue has", async () => {
		for (const code of locales.codes) {
			const messages = (await import(`../../messages/${code}.json`)).default;
			expect(typeof messages.common.appName, code).toBe("string");
			expect(typeof messages.metadata.title, code).toBe("string");
			expect(typeof messages.landing.heading, code).toBe("string");
		}
	});
});
