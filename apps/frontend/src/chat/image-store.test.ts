import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { signOutHere } from "../../app/components/sign-out";
import {
	forgetConversationImages,
	forgetHeldImages,
	heldImages,
	keepSentImages,
} from "./image-store";
import type { SentImage } from "./sent-images";

/**
 * The browser's picture store against an in-memory IndexedDB: the requests
 * answer asynchronously and a transaction completes once its requests have,
 * which is all the store relies on. `refuse` makes the next opens fail, as a
 * private window or a wedged profile does.
 */
type Row = Record<string, unknown> & { key: string };

interface Request<T> {
	result: T;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onupgradeneeded?: (() => void) | null;
	onblocked?: (() => void) | null;
}

function fakeIndexedDb() {
	const rows = new Map<string, Row>();
	const state = { opens: 0, refuse: 0, deletes: 0, open: 0 };
	const later = <T>(request: Request<T>, value: T, fail = false) => {
		queueMicrotask(() => {
			request.result = value;
			(fail ? request.onerror : request.onsuccess)?.();
		});
		return request;
	};
	const request = <T>(): Request<T> => ({
		result: undefined as T,
		onsuccess: null,
		onerror: null,
	});
	const store = {
		index: (field: string) => ({
			getAllKeys: (value: unknown) =>
				later(
					request<string[]>(),
					[...rows.values()]
						.filter((r) => r[field] === value)
						.map((r) => r.key),
				),
			getAll: (value: unknown) =>
				later(
					request<Row[]>(),
					[...rows.values()].filter((r) => r[field] === value),
				),
		}),
		put: (row: Row) => later(request(), rows.set(row.key, row) && row.key),
		delete: (key: string) => later(request(), rows.delete(key) && undefined),
		count: () => later(request<number>(), rows.size),
	};
	const db = {
		objectStoreNames: { contains: () => true },
		onversionchange: null as (() => void) | null,
		close: () => {
			state.open -= 1;
		},
		transaction: () => {
			const tx = {
				oncomplete: null as (() => void) | null,
				onerror: null,
				onabort: null,
				objectStore: () => store,
			};
			setTimeout(() => tx.oncomplete?.(), 0);
			return tx;
		},
	};
	const api = {
		open: () => {
			state.opens += 1;
			const r = request<typeof db>();
			if (state.refuse > 0) {
				state.refuse -= 1;
				return later(r, db, true);
			}
			state.open += 1;
			return later(r, db);
		},
		deleteDatabase: () => {
			state.deletes += 1;
			rows.clear();
			return later(request(), undefined);
		},
	};
	return { api, rows, state };
}

const picture = (messageId: string): SentImage => ({
	messageId,
	index: 0,
	value: "AAAA",
	mimeType: "image/jpeg",
});

const globals = globalThis as { indexedDB?: unknown };
let idb = fakeIndexedDb();

beforeEach(async () => {
	idb = fakeIndexedDb();
	globals.indexedDB = idb.api;
	// Drop whatever connection the previous test left cached.
	await forgetHeldImages();
	idb.state.deletes = 0;
});

afterAll(() => {
	delete globals.indexedDB;
});

describe("the pictures this browser kept", () => {
	test("a deleted conversation's pictures go with it, and only its", async () => {
		await keepSentImages("gone", [picture("m1")]);
		await keepSentImages("t2", [picture("m2")]);
		await forgetConversationImages("gone");
		expect((await heldImages("gone")).inOrder).toEqual([]);
		expect((await heldImages("t2")).inOrder).toEqual([picture("m2")]);
		// The deleted conversation's chat, still on screen, cannot put it back.
		await keepSentImages("gone", [picture("m1")]);
		expect((await heldImages("gone")).inOrder).toEqual([]);
	});

	test("signing out forgets every picture before the session ends", async () => {
		await keepSentImages("t1", [picture("m1")]);
		const exits: { callbackUrl: string; held: number }[] = [];
		await signOutHere("out", async ({ callbackUrl }) => {
			exits.push({ callbackUrl, held: idb.rows.size });
		});
		expect(exits).toEqual([{ callbackUrl: "/login?left=out", held: 0 }]);
		expect(idb.state.deletes).toBe(1);
	});

	test("forgetting everything closes this page's connection and needs no open", async () => {
		await keepSentImages("t1", [picture("m1")]);
		expect(idb.state.open).toBe(1);
		idb.state.refuse = Number.POSITIVE_INFINITY;
		await forgetHeldImages();
		expect(idb.state.open).toBe(0);
		expect(idb.state.deletes).toBe(1);
		expect(idb.rows.size).toBe(0);
	});

	test("an open that failed is tried again, not remembered as no store", async () => {
		idb.state.refuse = 1;
		expect((await heldImages("t1")).inOrder).toEqual([]);
		await keepSentImages("t1", [picture("m1")]);
		expect((await heldImages("t1")).inOrder).toEqual([picture("m1")]);
		expect(idb.state.opens).toBe(2);
	});
});
