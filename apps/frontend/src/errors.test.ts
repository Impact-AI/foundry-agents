import { expect, test } from "bun:test";
import { errorCodeOf, errorKey, retryAfterSeconds } from "./errors";

test("a code the backend names is kept", () => {
	expect(errorCodeOf({ code: "forbidden" }, 403)).toBe("forbidden");
	expect(errorCodeOf({ code: "account_deactivated" }, 403)).toBe(
		"account_deactivated",
	);
});

test("a metered refusal folds its pool flag into the code", () => {
	expect(errorCodeOf({ code: "rate_limited", retryAfterSeconds: 5 })).toBe(
		"rate_limited",
	);
	expect(errorCodeOf({ code: "rate_limited", pool: true })).toBe(
		"pool_exhausted",
	);
});

test("a voice refusal folds its reason into the code", () => {
	expect(errorCodeOf({ code: "refused", reason: "busy" }, 409)).toBe(
		"refused_busy",
	);
	expect(errorCodeOf({ code: "refused", reason: "capacity" }, 503)).toBe(
		"refused_capacity",
	);
	expect(errorCodeOf({ code: "refused", reason: "allowance" }, 429)).toBe(
		"rate_limited",
	);
	expect(errorCodeOf({ code: "refused", reason: "pool" }, 429)).toBe(
		"pool_exhausted",
	);
	expect(errorCodeOf({ code: "refused", reason: "made-up" }, 503)).toBe(
		"generic",
	);
});

test("a body with no code reads the status, else the generic line", () => {
	expect(errorCodeOf(null, 401)).toBe("unauthenticated");
	expect(errorCodeOf("not json", 404)).toBe("not_found");
	expect(errorCodeOf({ code: "something_new" }, 500)).toBe("generic");
	expect(errorCodeOf({}, 500)).toBe("generic");
});

test("an unknown code renders the generic key", () => {
	expect(errorKey("not_found")).toBe("not_found");
	expect(errorKey("whatever")).toBe("generic");
});

test("a wait is whole seconds, a minute when it cannot be read", () => {
	expect(retryAfterSeconds("42")).toBe(42);
	expect(retryAfterSeconds(2.2)).toBe(3);
	expect(retryAfterSeconds("soon")).toBe(60);
	expect(retryAfterSeconds(-1)).toBe(60);
});

test("a typed turn refused because a live session holds the thread waits as the session's own busy refusal does", () => {
	expect(errorCodeOf({ code: "thread.busy" }, 409)).toBe("refused_busy");
});
