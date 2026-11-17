import { afterEach, expect, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import type { Session } from "next-auth";
import { callerFromSession } from "./session";

let restore = () => {};
afterEach(() => restore());

const session = (id: string) =>
	({
		user: { id, roles: ["user"], groups: [], tier: "base" },
		expires: "",
	}) as unknown as Session;

test("a session from the local sign-in draws nobody once the mode is entra", () => {
	restore = scopedEnv({ AUTH_MODE: "entra" });
	expect(callerFromSession(session("local:ada"), "it")).toBeNull();
	expect(callerFromSession(session("oid-1"), "en")?.claims.sub).toBe("oid-1");
});

test("under the local mode the same session is the caller", () => {
	restore = scopedEnv({ AUTH_MODE: "local" });
	expect(callerFromSession(session("local:ada"), "it")).toEqual({
		claims: {
			sub: "local:ada",
			email: null,
			roles: ["user"],
			groups: [],
			tier: "base",
		},
		locale: "it",
	});
});

test("the caller carries when its session was signed in, for the backend to hold against an erase", () => {
	restore = scopedEnv({ AUTH_MODE: "local" });
	const signedIn = {
		user: { ...session("local:ada").user, signedInAt: 1_900_000_000 },
		expires: "",
	} as unknown as Session;
	expect(callerFromSession(signedIn, "en")?.claims.signedInAt).toBe(
		1_900_000_000,
	);
	expect(
		callerFromSession(session("local:ada"), "en")?.claims,
	).not.toHaveProperty("signedInAt");
});
