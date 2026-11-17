import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { closeRedis } from "./client/connection";
import { closeSubscriber, subscribe } from "./pubsub";
import {
	type FakeRedisServer,
	startFakeRedisServer,
} from "./testing/fake-server";

/** The subscriber against a Redis that is up and says nothing. */

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
	closeSubscriber();
	await closeRedis();
	server?.stop();
	server = undefined;
	restore?.();
	restore = undefined;
});

test("a subscribe the server never answers is null at the command deadline, and the next one is not held behind it", async () => {
	// Every file runs in one process: a subscriber an earlier file left connected would answer for this one.
	closeSubscriber();
	await closeRedis();
	server = startFakeRedisServer();
	server.behave("mute");
	restore = scopedEnv({
		REDIS_URL: server.url,
		REDIS_CONNECT_TIMEOUT_MS: "300",
		REDIS_COMMAND_TIMEOUT_MS: "50",
		REDIS_RETRY_COOLDOWN_MS: "60000",
	});
	const started = Date.now();
	const [first, second] = await Promise.all([
		subscribe("a", () => {}),
		subscribe("b", () => {}),
	]);
	expect(first).toBeNull();
	expect(second).toBeNull();
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(server.verbs()).toContain("SUBSCRIBE");
});
