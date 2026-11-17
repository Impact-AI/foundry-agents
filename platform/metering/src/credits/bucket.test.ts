import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { closeRedis } from "@platform/redis";
import {
	type FakeRedisServer,
	startFakeRedisServer,
} from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import { resetUnavailableReporting } from "../report";
import {
	awaitCredits,
	peekCredits,
	refundCredits,
	spendCredits,
	UNAVAILABLE_RETRY_SECONDS,
} from "./bucket";

/**
 * The bucket when it cannot be asked: no Redis at all, and a Redis that is
 * there but silent or refusing. Fail-open admits, fail-closed refuses with
 * the fixed wait, and neither throws.
 */

const policy = { capacity: 1, refillPerMinute: 1 };
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
	resetUnavailableReporting();
});

function pointAt(url: string | undefined): void {
	restore = scopedEnv({
		REDIS_URL: url,
		REDIS_CONNECT_TIMEOUT_MS: "300",
		REDIS_COMMAND_TIMEOUT_MS: "100",
		REDIS_RETRY_COOLDOWN_MS: "0",
	});
}

test("without Redis a spend admits, a peek admits, a refund is silent, and a wait ends at once", async () => {
	pointAt(undefined);
	const started = Date.now();
	expect(await spendCredits("k", policy)).toEqual({
		allowed: true,
		retryAfterSeconds: 0,
	});
	expect(await spendCredits("k", policy, 99)).toMatchObject({ allowed: true });
	expect((await peekCredits("k", policy)).allowed).toBe(true);
	await refundCredits("k", policy, 99);
	expect(await awaitCredits("k", policy, 0)).toBe(true);
	expect(Date.now() - started).toBeLessThan(400);
});

test("fail-closed without Redis refuses with the fixed wait, except a refund, which is never refused", async () => {
	pointAt(undefined);
	const closed = {
		allowed: false,
		retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
	};
	expect(await spendCredits("k", policy, 1, { failClosed: true })).toEqual(
		closed,
	);
	// A peek fails the way the spend it previews would: a page that promised
	// room the spend then refused would be lying.
	expect(await peekCredits("k", policy, 1, { failClosed: true })).toEqual(
		closed,
	);
	await refundCredits("k", policy, 1);
});

test("a Redis that never answers is the same outcome as none, promptly, in both postures", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	server.behave("mute");
	const started = Date.now();
	expect((await spendCredits("k", policy)).allowed).toBe(true);
	expect(Date.now() - started).toBeLessThan(1_000);
	expect(await spendCredits("k", policy, 1, { failClosed: true })).toEqual({
		allowed: false,
		retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
	});
	expect(server.verbs()).toContain("EVAL");
});

test("a Redis that refuses the script, or answers something that is not a verdict, is reported and answered by the fallback", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	const error = quiet[0];
	error?.mockClear();
	server.behave("error");
	expect((await spendCredits("k", policy)).allowed).toBe(true);
	expect(error).toHaveBeenCalled();
	// `+OK` is not {allowed, retry}: an answer the script cannot have given is
	// not trusted as an admission.
	server.behave("ok");
	expect(await spendCredits("k", policy, 1, { failClosed: true })).toEqual({
		allowed: false,
		retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
	});
});
