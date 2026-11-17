import { expect, test } from "bun:test";
import {
	isConflict,
	isForbidden,
	isNotFound,
	isPreconditionFailed,
} from "./azure-errors";

test("a 404 is not found; a 403 is forbidden; a 409 is a conflict; 412 and 409 are a precondition failed; anything else is neither", () => {
	expect(isNotFound({ statusCode: 404 })).toBe(true);
	expect(isForbidden({ statusCode: 403 })).toBe(true);
	expect(isConflict({ statusCode: 409 })).toBe(true);
	expect(isPreconditionFailed({ statusCode: 412 })).toBe(true);
	expect(isPreconditionFailed({ statusCode: 409 })).toBe(true);
	for (const err of [
		{ statusCode: 500 },
		new Error("plain"),
		null,
		undefined,
		"text",
	]) {
		expect(isNotFound(err)).toBe(false);
		expect(isForbidden(err)).toBe(false);
		expect(isConflict(err)).toBe(false);
		expect(isPreconditionFailed(err)).toBe(false);
	}
});
