import { describe, expect, test } from "bun:test";
import { isLogoKey, logoKeyType, logoVersion } from "./brand";
import { appearanceAttributes, appearanceCss } from "./css";
import { appearanceDefaults, parseAppearance } from "./document";
import written from "./fixtures/paper-preset.json";
import writtenSheet from "./fixtures/paper-preset.sheet.json";
import { SHIPPED_PALETTE } from "./palette";

const defaults = appearanceDefaults(["en", "it", "es", "fr", "de"]);
const read = (stored: unknown) => {
	const refused: string[] = [];
	return { value: parseAppearance(stored, defaults, refused), refused };
};

const LOGO = `appearance/logo/${"a".repeat(64)}.png`;

describe("the defaults", () => {
	test("carry a name and a welcome line per language, every one the catalogue's", () => {
		const empty = { en: "", it: "", es: "", fr: "", de: "" };
		expect(defaults.brand).toEqual({ name: empty, welcome: empty, logo: "" });
	});

	test("are what nothing stored reads as, and what an empty document reads as", () => {
		expect(read(null)).toEqual({ value: defaults, refused: [] });
		expect(read({})).toEqual({ value: defaults, refused: [] });
	});

	test("inject nothing: no attribute on the page and an empty sheet", () => {
		expect(appearanceCss(defaults)).toBe("");
		expect(appearanceAttributes(defaults)).toEqual({});
	});
});

describe("parsing", () => {
	test("keeps every leaf that passes its rule, as written", () => {
		const { value, refused } = read({
			scheme: "dark",
			palette: { dark: { primary: "#FFD400" } },
			type: { font: "serif", size: 18, steps: "wide" },
			space: { density: "compact" },
			shape: { radius: 0 },
			brand: {
				name: { it: "Assistente" },
				welcome: { en: "Hello." },
				logo: LOGO,
			},
		});
		expect(refused).toEqual([]);
		expect(value.scheme).toBe("dark");
		expect(value.palette.dark.primary).toBe("#FFD400");
		expect(value.palette.dark.surface).toBe(SHIPPED_PALETTE.dark.surface);
		expect(value.type).toEqual({ font: "serif", size: 18, steps: "wide" });
		expect(value.space.density).toBe("compact");
		expect(value.shape.radius).toBe(0);
		expect(value.brand.name.it).toBe("Assistente");
		expect(value.brand.name.en).toBe("");
		expect(value.brand.welcome.en).toBe("Hello.");
		expect(value.brand.logo).toBe(LOGO);
	});

	test("refuses each bad leaf back to its default and names it, keeping the rest", () => {
		const { value, refused } = read({
			scheme: "sepia",
			palette: { dark: { surface: "red", primary: "#7fb2ff;}body{x" } },
			type: { font: "Comic Sans", size: 40, steps: 2 },
			space: { density: "airy" },
			shape: { radius: -1 },
			brand: {
				name: { en: "x".repeat(61), it: "Riga\nnuova", de: "Assistent" },
				welcome: { en: " padded " },
				logo: "media/../appearance/logo/x.svg",
			},
		});
		expect(value).toEqual({
			...defaults,
			brand: {
				...defaults.brand,
				name: { ...defaults.brand.name, de: "Assistent" },
			},
		});
		expect(refused.sort()).toEqual(
			[
				"scheme",
				"palette.dark.surface",
				"palette.dark.primary",
				"type.font",
				"type.size",
				"type.steps",
				"space.density",
				"shape.radius",
				"brand.name.en",
				"brand.name.it",
				"brand.welcome.en",
				"brand.logo",
			].sort(),
		);
	});

	test("ignores fields this frontend does not honour, a language it does not speak, and junk of any shape", () => {
		expect(
			read({
				layout: { key: "stage-wide", split: 50 },
				preview: { origins: ["https://admin.example.com"] },
				brand: { name: { ja: "アシスタント" } },
				somethingNew: { colour: "#000000" },
			}),
		).toEqual({ value: defaults, refused: [] });
		for (const junk of [42, "x", [], { palette: [] }, { brand: null }])
			expect(read(junk).value).toEqual(defaults);
	});

	test("bounds are inclusive at both ends, and a size is whole", () => {
		for (const stored of [
			{ type: { size: 14 } },
			{ type: { size: 20 } },
			{ shape: { radius: 0 } },
			{ shape: { radius: 24 } },
		])
			expect(read(stored).refused).toEqual([]);
		expect(read({ type: { size: 16.5 } }).refused).toEqual(["type.size"]);
		expect(read({ shape: { radius: 25 } }).refused).toEqual(["shape.radius"]);
	});
});

describe("a palette that would make text unreadable", () => {
	test("is refused whole, back to the shipped palette of its scheme, and named", () => {
		// A light page under the dark scheme's light text: every other colour is fine.
		const { value, refused } = read({
			palette: {
				dark: { surface: "#f0f0f0", primary: "#123456" },
				light: { primary: "#1b3a8a" },
			},
		});
		expect(refused).toEqual(["palette.dark"]);
		expect(value.palette.dark).toEqual(SHIPPED_PALETTE.dark);
		expect(value.palette.light.primary).toBe("#1b3a8a");
	});

	test("in either scheme", () => {
		const { value, refused } = read({
			palette: { light: { primary: "#f6f7f9" } },
		});
		expect(refused).toEqual(["palette.light"]);
		expect(value.palette.light).toEqual(SHIPPED_PALETTE.light);
	});
});

describe("the logo", () => {
	test("is a key under its own prefix, named for its bytes, of a raster type", () => {
		expect(isLogoKey("")).toBe(true);
		expect(isLogoKey(LOGO)).toBe(true);
		expect(logoKeyType(LOGO)).toBe("image/png");
		expect(logoKeyType(LOGO.replace(".png", ".jpg"))).toBe("image/jpeg");
		expect(logoVersion(LOGO)).toBe("a".repeat(16));
		for (const bad of [
			"appearance/logo/abc.png",
			`appearance/logo/${"a".repeat(64)}.svg`,
			`media/${"a".repeat(64)}.png`,
			`appearance/logo/../${"a".repeat(64)}.png`,
			"data:image/png;base64,iVBORw0KGgo=",
			"https://example.com/logo.png",
		]) {
			expect(isLogoKey(bad), bad).toBe(false);
			expect(logoKeyType(bad), bad).toBeNull();
		}
	});
});

describe("the injected sheet", () => {
	test("a changed palette sets the primitives for both schemes, pinned or preferred", () => {
		const doc = {
			...defaults,
			palette: {
				...defaults.palette,
				dark: { ...SHIPPED_PALETTE.dark, primary: "#ffd400" },
			},
		};
		const css = appearanceCss(doc);
		expect(css).toStartWith(":root[data-appearance]{");
		expect(css).toContain("--brand-primary:#ffd400");
		expect(css).toContain("--brand-on-primary:#081120");
		expect(css).toContain(
			'@media (prefers-color-scheme: light){:root[data-appearance]:not([data-scheme="dark"]){--brand-surface:#f4f6fa;',
		);
		expect(css).toContain(':root[data-appearance][data-scheme="light"]{');
		expect(appearanceAttributes(doc)).toEqual({
			"data-appearance": "",
			"data-palette": "",
		});
	});

	test("each other group is emitted on its own, and only when it moves", () => {
		expect(appearanceCss({ ...defaults, shape: { radius: 0 } })).toBe(
			":root[data-appearance]{--radius-sm:0px;--radius:0px;--radius-lg:0px;--radius-xl:0px}",
		);
		expect(
			appearanceCss({ ...defaults, type: { ...defaults.type, font: "serif" } }),
		).toBe(
			':root[data-appearance]{--font-sans:Georgia, "Iowan Old Style", "Times New Roman", serif}',
		);
		expect(
			appearanceCss({ ...defaults, type: { ...defaults.type, size: 18 } }),
		).toBe(":root[data-appearance]{--font-base:18px}");
		expect(appearanceCss({ ...defaults, space: { density: "compact" } })).toBe(
			":root[data-appearance]{--space-1:3px;--space-2:6px;--space-3:9px;--space-4:12px;--space-5:15px;--space-6:18px;--space-8:24px;--space-10:30px;--gutter:12px}",
		);
		expect(
			appearanceCss({
				...defaults,
				type: { ...defaults.type, steps: "tight" },
			}),
		).toBe(
			":root[data-appearance]{--text-xs:0.79rem;--text-sm:0.889rem;--text-md:1rem;--text-lg:1.125rem;--text-xl:1.266rem;--text-2xl:1.424rem;--text-3xl:clamp(1.424rem, 3vw, 1.802rem)}",
		);
	});

	test("a pinned scheme alone is an attribute and no sheet", () => {
		const doc = { ...defaults, scheme: "light" as const };
		expect(appearanceCss(doc)).toBe("");
		expect(appearanceAttributes(doc)).toEqual({ "data-scheme": "light" });
	});

	test("a stored value the parser refused never reaches the sheet", () => {
		const { value } = read({
			palette: { dark: { primary: "#fff;}</style><script>alert(1)</script>" } },
			type: { font: "x;}body{display:none" },
		});
		expect(appearanceCss(value)).toBe("");
	});
});

describe("a document another writer of `appearance` produced", () => {
	// Written by another tool's own appearance editor (its "Paper" preset, a
	// name, a welcome line, a logo, a layout and a preview origin) and copied
	// here as JSON, beside the sheet and attributes that tool's own app draws
	// from it: the same document must read the same in both.
	test("parses with nothing refused, the fields this frontend draws kept as written", () => {
		const { value, refused } = read(written);
		expect(refused).toEqual([]);
		expect(value.scheme).toBe("light");
		expect(written.palette).toEqual(value.palette);
		expect(written.type).toEqual(value.type);
		expect(written.space).toEqual(value.space);
		expect(written.shape).toEqual(value.shape);
		expect(value.brand).toEqual({
			name: { ...defaults.brand.name, ...written.brand.name },
			welcome: { ...defaults.brand.welcome, ...written.brand.welcome },
			logo: written.brand.logo,
		});
		expect(value).not.toHaveProperty("layout");
		expect(value).not.toHaveProperty("preview");
	});

	test("puts exactly the sheet and attributes on the page that the other tool's app does", () => {
		const { value } = read(written);
		expect(appearanceCss(value)).toBe(writtenSheet.css);
		expect(appearanceAttributes(value)).toEqual(writtenSheet.attributes);
	});
});
