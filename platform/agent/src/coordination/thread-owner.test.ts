import { expect, test } from "bun:test";
import type { SharedMemo } from "@platform/redis";
import {
	layeredThreadLookup,
	ownershipOf,
	ThreadLookupError,
} from "./thread-owner";

/** The fleet's memo, as a map, so the middle layer's reads and writes are visible. */
function fakeMemo(): SharedMemo & {
	entries: Map<string, unknown>;
	reads: number;
} {
	const entries = new Map<string, unknown>();
	const memo = {
		entries,
		reads: 0,
		async read<T>(name: string) {
			memo.reads++;
			return entries.has(name)
				? { value: entries.get(name) as T, at: 1 }
				: null;
		},
		async write(name: string, value: unknown) {
			entries.set(name, value);
		},
		async drop(name: string) {
			entries.delete(name);
		},
	};
	return memo;
}

function fakeStore(owners: Record<string, string>, fail = false) {
	let reads = 0;
	return {
		reads: () => reads,
		async ownerOf(threadId: string) {
			reads++;
			if (fail) throw new Error("pool exhausted");
			return owners[threadId] ?? null;
		},
	};
}

test("a hit is served from the process, then the fleet, then the claim — and only a hit is cached", async () => {
	const memo = fakeMemo();
	const store = fakeStore({ t1: "a::1" });
	const lookup = layeredThreadLookup(store.ownerOf, memo);
	expect(await ownershipOf(lookup, "t1", "a::1")).toBe("mine");
	expect(await ownershipOf(lookup, "t1", "b::9")).toBe("theirs");
	expect(store.reads()).toBe(1);
	expect(memo.entries.get("thread-owner:t1")).toBe("a::1");
	expect(await ownershipOf(lookup, "new", "a::1")).toBe("nobodys");
	expect(await ownershipOf(lookup, "new", "a::1")).toBe("nobodys");
	expect(store.reads()).toBe(3);
	expect(memo.entries.has("thread-owner:new")).toBe(false);
});

test("another replica answers from the fleet's memo without touching the claim, and a forget empties every layer", async () => {
	const memo = fakeMemo();
	memo.entries.set("thread-owner:t1", "a::1");
	const store = fakeStore({ t1: "a::1" });
	const lookup = layeredThreadLookup(store.ownerOf, memo);
	expect(await lookup.getOwner("t1")).toBe("a::1");
	expect(await lookup.getOwner("t1")).toBe("a::1");
	expect(store.reads()).toBe(0);
	expect(memo.reads).toBe(1);
	await lookup.forget("t1");
	expect(memo.entries.has("thread-owner:t1")).toBe(false);
	expect(await lookup.getOwner("t1")).toBe("a::1");
	expect(store.reads()).toBe(1);
});

test("a store that cannot answer is a typed failure, never a pass", async () => {
	const lookup = layeredThreadLookup(fakeStore({}, true).ownerOf, fakeMemo());
	await expect(ownershipOf(lookup, "t1", "a::1")).rejects.toBeInstanceOf(
		ThreadLookupError,
	);
});
