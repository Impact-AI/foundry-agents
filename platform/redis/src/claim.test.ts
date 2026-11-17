import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import {
	claimHolder,
	claimOnce,
	extendClaim,
	MAX_OWNER_BYTES,
	releaseClaim,
} from "./claim";
import { closeRedis, getRedis } from "./client/connection";
import { publish, subscribe } from "./pubsub";
import {
	type FakeRedisServer,
	startFakeRedisServer,
} from "./testing/fake-server";

const quiet: ReturnType<typeof spyOn>[] = [];
let restore: (() => void) | undefined;
let server: FakeRedisServer | undefined;

beforeAll(() => {
	quiet.push(spyOn(console, "error").mockImplementation(() => {}));
	quiet.push(spyOn(console, "warn").mockImplementation(() => {}));
});

afterAll(() => {
	for (const spy of quiet) spy.mockRestore();
});

afterEach(async () => {
	await closeRedis();
	server?.stop();
	server = undefined;
	restore?.();
	restore = undefined;
});

function pointAt(url: string | undefined) {
	restore = scopedEnv({
		REDIS_URL: url,
		REDIS_CONNECT_TIMEOUT_MS: "300",
		REDIS_COMMAND_TIMEOUT_MS: "50",
		REDIS_RETRY_COOLDOWN_MS: "0",
	});
}

test("without Redis every claim is uncoordinated, by name", async () => {
	pointAt(undefined);
	expect(await claimOnce("k", "me", 1000)).toEqual({ outcome: "unavailable" });
	expect(await claimHolder("k")).toEqual({ outcome: "unavailable" });
	expect(await releaseClaim("k", "me")).toBe("unavailable");
});

test("a server that never answers is uncoordinated within the deadline", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	server.behave("mute");
	const started = Date.now();
	expect(await claimOnce("k", "me", 1000)).toEqual({ outcome: "unavailable" });
	expect(await releaseClaim("k", "me")).toBe("unavailable");
	expect(Date.now() - started).toBeLessThan(2000);
});

test("a reply that cannot be the command's is not trusted: the connection is dropped and the claim is uncoordinated", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	const before = await getRedis();
	server.behave("integer");
	expect(await claimOnce("k", "me", 1000)).toEqual({ outcome: "unavailable" });
	expect(await getRedis()).not.toBe(before);
	expect(server.dials()).toBe(2);
});

test("an owner is short and non-empty, and a TTL is a positive integer of milliseconds", async () => {
	pointAt(undefined);
	await expect(claimOnce("k", "", 1000)).rejects.toThrow(RangeError);
	await expect(
		claimOnce("k", "o".repeat(MAX_OWNER_BYTES + 1), 1000),
	).rejects.toThrow(RangeError);
	await expect(claimOnce("k", "me", 0)).rejects.toThrow(RangeError);
	await expect(claimOnce("k", "me", 1.5)).rejects.toThrow(RangeError);
	await expect(claimOnce("k", "me", -1)).rejects.toThrow(RangeError);
});

test("without Redis an extension and the fleet's channels are unavailable, by name", async () => {
	pointAt(undefined);
	expect(await extendClaim("k", "replica-a", 1_000)).toBe("unavailable");
	expect(await publish("channel", "message")).toBeNull();
	expect(await subscribe("channel", () => {})).toBeNull();
});

test("a refused claim is held even when Redis does not say by whom", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	server.behaveFor("SET", "nil");
	server.behaveFor("GET", "mute");
	expect(await claimOnce("k", "me", 1000)).toEqual({
		outcome: "held",
		owner: null,
	});
});
