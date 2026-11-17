import { expect, test } from "bun:test";
import { BackendError, type Caller } from "@/src/backend/client";
import { readSettings } from "./reads";

const caller = { claims: { sub: "a" }, locale: "en" } as unknown as Caller;
const remembered = { items: [] };

test("an account an erase has shut reads as null, so the page offers the erase again instead of failing", async () => {
	const refused = () => Promise.reject(new BackendError(401, "account_erased"));
	expect(
		await readSettings(caller, {
			readPerson: refused,
			readMemory: async () => remembered,
		}),
	).toBeNull();
});

test("any other refusal is the page's error, and a readable account is read", async () => {
	const unavailable = () =>
		Promise.reject(new BackendError(503, "account_unavailable"));
	await expect(
		readSettings(caller, {
			readPerson: unavailable,
			readMemory: async () => remembered,
		}),
	).rejects.toThrow("503");
	const person = { name: "Ada", about: null, preferences: null };
	expect(
		await readSettings(caller, {
			readPerson: async () => person,
			readMemory: async () => remembered,
		}),
	).toEqual({ person, remembered });
});

test("a 401 that names no erase is a session the backend refuses: sent to sign in, never shown the erase", async () => {
	const refused = () =>
		Promise.reject(new BackendError(401, "unauthenticated"));
	const signIn = () => {
		throw new Error("to sign-in");
	};
	await expect(
		readSettings(
			caller,
			{ readPerson: refused, readMemory: async () => remembered },
			signIn,
		),
	).rejects.toThrow("to sign-in");
});
