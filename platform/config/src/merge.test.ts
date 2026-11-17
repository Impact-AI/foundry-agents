import { expect, test } from "bun:test";
import {
	atLeast,
	integerBetween,
	mergeOverDefault,
	nonNegativeInteger,
	numberBetween,
	oneOf,
	positiveInteger,
	stringList,
} from "./merge";

/** A shape with every kind of leaf the walker has to judge. */
const DEFAULTS = {
	chat: { perDay: 200 },
	tts: { perDay: 400, burst: 30, refillPerMinute: 60 },
	nested: { deeper: { seconds: 120 } },
	switches: { on: true, label: "default" },
};

test("a stored leaf of the default's kind replaces it; everything else keeps the default", () => {
	const merged = mergeOverDefault(
		{ chat: { perDay: 5 }, tts: { burst: 3 } },
		DEFAULTS,
	);
	expect(merged.chat.perDay).toBe(5);
	expect(merged.tts).toEqual({ perDay: 400, burst: 3, refillPerMinute: 60 });
	expect(merged.nested.deeper.seconds).toBe(120);
	expect(merged.switches).toEqual({ on: true, label: "default" });
});

test("a missing section, a section of the wrong kind, and no document at all are the default", () => {
	expect(mergeOverDefault(undefined, DEFAULTS)).toEqual(DEFAULTS);
	expect(mergeOverDefault(null, DEFAULTS)).toEqual(DEFAULTS);
	expect(mergeOverDefault("limits", DEFAULTS)).toEqual(DEFAULTS);
	expect(mergeOverDefault({ tts: 7 }, DEFAULTS)).toEqual(DEFAULTS);
	expect(mergeOverDefault({ tts: [30, 60] }, DEFAULTS)).toEqual(DEFAULTS);
	expect(mergeOverDefault({ nested: { deeper: null } }, DEFAULTS)).toEqual(
		DEFAULTS,
	);
});

test("no number can remove a bound: zero, a negative, NaN, infinity and a numeric string all fall back", () => {
	const refused: string[] = [];
	const merged = mergeOverDefault(
		{
			chat: { perDay: 0 },
			tts: {
				perDay: -1,
				burst: Number.NaN,
				refillPerMinute: Number.POSITIVE_INFINITY,
			},
			nested: { deeper: { seconds: "120" } },
		},
		DEFAULTS,
		{ refused },
	);
	expect(merged).toEqual(DEFAULTS);
	expect(refused).toEqual([
		"chat.perDay",
		"tts.perDay",
		"tts.burst",
		"tts.refillPerMinute",
		"nested.deeper.seconds",
	]);
});

test("a fraction is a number like any other, and a null leaf is a wrong kind, not an absence", () => {
	const refused: string[] = [];
	const merged = mergeOverDefault(
		{ chat: { perDay: 0.5 }, tts: { burst: null } },
		DEFAULTS,
		{ refused },
	);
	expect(merged.chat.perDay).toBe(0.5);
	expect(merged.tts.burst).toBe(30);
	expect(refused).toEqual(["tts.burst"]);
});

test("a switch is only a switch when it is a boolean, and a string must be a string", () => {
	const refused: string[] = [];
	const merged = mergeOverDefault(
		{ switches: { on: "true", label: 42 } },
		DEFAULTS,
		{ refused },
	);
	expect(merged.switches).toEqual({ on: true, label: "default" });
	expect(refused).toEqual(["switches.on", "switches.label"]);
	expect(
		mergeOverDefault({ switches: { on: false, label: "x" } }, DEFAULTS)
			.switches,
	).toEqual({ on: false, label: "x" });
});

test("keys the default does not have are ignored, at any depth", () => {
	const merged = mergeOverDefault(
		{ unlimited: true, chat: { perDay: 7, unlimited: -1 }, extra: { x: 1 } },
		DEFAULTS,
	);
	expect(merged).toEqual({ ...DEFAULTS, chat: { perDay: 7 } });
	expect(Object.keys(merged)).toEqual(Object.keys(DEFAULTS));
});

test("the result is a fresh object: the default is never written to", () => {
	const merged = mergeOverDefault({ chat: { perDay: 1 } }, DEFAULTS);
	merged.chat.perDay = 999;
	expect(DEFAULTS.chat.perDay).toBe(200);
});

test("a path named in `accept` is judged by its own rule, and the default rule stays for the rest", () => {
	const refused: string[] = [];
	const merged = mergeOverDefault(
		{
			chat: { perDay: 0 },
			tts: { perDay: 2.5, burst: 1.5, refillPerMinute: 0 },
			switches: { label: "loud" },
		},
		DEFAULTS,
		{
			accept: {
				"chat.perDay": nonNegativeInteger,
				"tts.burst": atLeast(1),
				"switches.label": oneOf(["default", "quiet"]),
			},
			numbers: positiveInteger,
			refused,
		},
	);
	expect(merged.chat.perDay).toBe(0);
	expect(merged.tts).toEqual({ perDay: 400, burst: 1.5, refillPerMinute: 60 });
	expect(merged.switches.label).toBe("default");
	expect(refused).toEqual([
		"tts.perDay",
		"tts.refillPerMinute",
		"switches.label",
	]);
});

test("a window refuses a typo on either side, and a closed list refuses what is not on it", () => {
	const window = integerBetween(16, 128);
	expect(window(16, 0)).toBe(true);
	expect(window(128, 0)).toBe(true);
	expect(window(15, 0)).toBe(false);
	expect(window(129, 0)).toBe(false);
	expect(window(64.5, 0)).toBe(false);
	expect(window("64", 0)).toBe(false);
	const effort = oneOf(["low", "high"]);
	expect(effort("low", "low")).toBe(true);
	expect(effort("unlimited", "low")).toBe(false);
	expect(effort(undefined, "low")).toBe(false);
});

test("a number window takes a fraction inside it; a string list takes an empty one and refuses a mixed one", () => {
	const unit = numberBetween(0, 1);
	expect(unit(0.5, 0)).toBe(true);
	expect(unit(0, 0)).toBe(true);
	expect(unit(1.5, 0)).toBe(false);
	expect(unit("0.5", 0)).toBe(false);
	expect(stringList([], [])).toBe(true);
	expect(stringList(["a", "b"], [])).toBe(true);
	expect(stringList(["a", 1], [])).toBe(false);
	expect(stringList("a", [])).toBe(false);
	const merged = mergeOverDefault(
		{ tags: ["x"], names: ["y", 2] },
		{ tags: ["a"], names: ["b"] },
		{ accept: { tags: stringList, names: stringList } },
	);
	expect(merged).toEqual({ tags: ["x"], names: ["b"] });
});
