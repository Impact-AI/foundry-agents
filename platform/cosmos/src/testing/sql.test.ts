import { expect, test } from "bun:test";
import { parseCondition, parseQuery } from "./sql";

test("SQL outside the subset the stores write is refused, never answered differently", () => {
	for (const query of [
		"SELECT c.id FROM c",
		"SELECT VALUE COUNT(1) FROM c",
		"SELECT * FROM c JOIN t IN c.tags",
		"SELECT * FROM c WHERE STARTSWITH(c.id, 'a')",
		"SELECT * FROM c WHERE c.id IN ('a', 'b')",
		"SELECT * FROM c GROUP BY c.id",
	])
		expect(() => parseQuery(query), query).toThrow(/stand-in/);
	expect(() => parseCondition("WHERE c.a = 1")).toThrow(/stand-in/);
});
