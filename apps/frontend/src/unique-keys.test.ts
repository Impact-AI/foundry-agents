import { expect, test } from "bun:test";
import { uniqueKeys } from "./unique-keys";

test("a name that repeats gets a key of its own each time; one that does not keeps its name", () => {
	const keys = uniqueKeys(["series", "north", "series", "series"]);
	expect(keys[1]).toBe("north");
	expect(keys[0]).toBe("series");
	expect(new Set(keys).size).toBe(4);
});
