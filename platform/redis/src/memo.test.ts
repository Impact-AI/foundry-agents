import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { closeRedis } from "./client/connection";
import { keyNamespace } from "./keys";
import { sharedMemo } from "./memo";
import {
	type FakeRedisServer,
	startFakeRedisServer,
} from "./testing/fake-server";

/** The memo as a request path sees it when Redis is missing, sick or silent. */

const memo = sharedMemo(keyNamespace("svc"));
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

test("without Redis a read is a miss and the writers are silent no-ops", async () => {
	pointAt(undefined);
	await memo.write("nowhere", { a: 1 }, 10);
	expect(await memo.read("nowhere")).toBeNull();
	await memo.drop("nowhere");
});

test("a server that never answers is a miss within the deadline, and the writers still resolve", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	server.behave("mute");
	const started = Date.now();
	expect(await memo.read("wedged")).toBeNull();
	await memo.write("wedged", { a: 1 }, 10);
	await memo.drop("wedged");
	expect(Date.now() - started).toBeLessThan(2000);
});

test("a server that refuses is a miss and a resolved write", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	server.behave("error");
	expect(await memo.read("sick")).toBeNull();
	await memo.write("sick", 1, 10);
	await memo.drop("sick");
});

test("a value over the budget and a TTL under a second are refused before any write", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	const small = sharedMemo(keyNamespace("svc"), { maxBytes: 16 });
	await small.write("big", "x".repeat(32), 10);
	await small.write("brief", 1, 0.5);
	await small.write("off", 1, 0);
	expect(server.verbs()).not.toContain("SET");
});

test("a value JSON cannot hold is not shared, and the write does not throw", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	await expect(memo.write("big", 1n, 60)).resolves.toBeUndefined();
	expect(server.verbs()).not.toContain("SET");
});
