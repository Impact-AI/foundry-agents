import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
	resetAzureCredential,
	resetSingleton,
	setAzureCredential,
} from "@platform/config";
import { scopedEnv } from "@platform/test-support";
import { RedisClient } from "bun";
import {
	type FakeRedisServer,
	startFakeRedisServer,
} from "../testing/fake-server";
import { REDIS_TOKEN_PROVIDER } from "./auth";
import {
	assertRedisReachable,
	closeRedis,
	getRedis,
	isRedisConfigured,
	RedisUnreachableError,
	redisAnswers,
} from "./connection";
import { RedisCommandTimeout } from "./deadline";
import { commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS } from "./options";

/**
 * The contract without a Redis worth the name: nothing here needs a server
 * that answers, because what is under test is every way one can fail to.
 */

const quiet: ReturnType<typeof spyOn>[] = [];
let restore: (() => void) | undefined;
let server: FakeRedisServer | undefined;

beforeAll(() => {
	// The failures below are the point; their log lines are not.
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
	resetAzureCredential();
	resetSingleton(REDIS_TOKEN_PROVIDER);
});

const OBJECT_ID = "11111111-2222-3333-4444-555555555555";

/** A credential whose tokens are numbered and live `lifeMs`, so a redial is visible. */
function mintingTokens(lifeMs: number): { minted: () => number } {
	let n = 0;
	setAzureCredential({
		getToken: async () => ({
			token: `token-${++n}`,
			expiresOnTimestamp: Date.now() + lifeMs,
		}),
	});
	return { minted: () => n };
}

function pointAt(url: string | undefined, knobs: Record<string, string> = {}) {
	restore = scopedEnv({
		REDIS_URL: url,
		REDIS_CONNECT_TIMEOUT_MS: "300",
		REDIS_COMMAND_TIMEOUT_MS: "100",
		REDIS_RETRY_COOLDOWN_MS: "0",
		...knobs,
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("without REDIS_URL nothing is dialled and every answer is the fallback's", async () => {
	pointAt(undefined);
	expect(isRedisConfigured()).toBe(false);
	expect(await getRedis()).toBeNull();
	expect(await redisAnswers()).toBe(false);
});

test("a refused dial answers null, and null again without a dial until the cooldown has passed", async () => {
	const closed = startFakeRedisServer();
	closed.stop();
	pointAt(`redis://127.0.0.1:${closed.port}`, {
		REDIS_RETRY_COOLDOWN_MS: "60000",
	});
	expect(await getRedis()).toBeNull();
	server = startFakeRedisServer(closed.port);
	expect(await getRedis()).toBeNull();
	expect(server.dials()).toBe(0);
	// Closing is also how a test says "dial again now".
	await closeRedis();
	expect(await getRedis()).not.toBeNull();
	expect(server.dials()).toBe(1);
});

test("a command the server never answers rejects at the deadline, naming the verb, and the connection is dropped", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	const first = await getRedis();
	expect(first).not.toBeNull();
	server.behave("mute");
	const started = Date.now();
	const failure = await first?.get("k").then(
		() => null,
		(err: unknown) => err,
	);
	expect(failure).toBeInstanceOf(RedisCommandTimeout);
	expect((failure as Error).message).toMatch(/redis get timed out after 100ms/);
	expect(Date.now() - started).toBeLessThan(1000);
	// A reply nobody consumed shifts every later one, so the socket goes and
	// the next caller gets a fresh dial.
	expect(await getRedis()).not.toBe(first);
	expect(server.dials()).toBe(2);
});

test("a server that refuses a command rejects at once, and the connection is kept", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	const client = await getRedis();
	server.behave("error");
	await expect(client?.send("PING", [])).rejects.toThrow(/refused/);
	expect(await getRedis()).toBe(client);
	expect(server.dials()).toBe(1);
});

test("a lost socket is noticed, and redialled after the cooldown", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	const client = await getRedis();
	expect(client).not.toBeNull();
	const port = server.port;
	server.stop();
	await sleep(50);
	expect(await getRedis()).toBeNull();
	server = startFakeRedisServer(port);
	const again = await getRedis();
	expect(again).not.toBeNull();
	expect(again).not.toBe(client);
});

test("redisAnswers is the PING under the same deadline", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	expect(await redisAnswers()).toBe(true);
	server.behave("mute");
	expect(await redisAnswers()).toBe(false);
});

test("the command deadline has no opt-out: zero and junk are the default", () => {
	restore = scopedEnv({ REDIS_COMMAND_TIMEOUT_MS: "0" });
	expect(commandTimeoutMs()).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
	process.env.REDIS_COMMAND_TIMEOUT_MS = "soon";
	expect(commandTimeoutMs()).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
	process.env.REDIS_COMMAND_TIMEOUT_MS = "250";
	expect(commandTimeoutMs()).toBe(250);
});

test("the password form dials with the URL's own credential, as it always has", async () => {
	server = startFakeRedisServer();
	pointAt(`redis://someone:secret@127.0.0.1:${server.port}`);
	expect(await getRedis()).not.toBeNull();
	expect(server.handshakes()).toEqual([
		{ username: "someone", password: "secret" },
	]);
});

test("the Entra form dials as the object id with a minted token, and redials with a fresh one before it expires", async () => {
	server = startFakeRedisServer();
	const credential = mintingTokens(1_500);
	pointAt(`redis://${OBJECT_ID}@127.0.0.1:${server.port}`);
	const first = await getRedis();
	expect(first).not.toBeNull();
	expect(server.handshakes()).toEqual([
		{ username: OBJECT_ID, password: "token-1" },
	]);
	// A planned redial: no cooldown, no fallback, and the old connection is
	// still answering while the new one takes over.
	await sleep(1_300);
	expect(server.dials()).toBe(2);
	expect(server.handshakes()[1]).toEqual({
		username: OBJECT_ID,
		password: "token-2",
	});
	expect(credential.minted()).toBe(2);
	const second = await getRedis();
	expect(second).not.toBeNull();
	expect(second).not.toBe(first);
	expect(await second?.send("PING", [])).toBe("OK");
});

test("a planned redial that cannot be dialled is tried again before the token expires, and the connection is replaced without a loss", async () => {
	server = startFakeRedisServer();
	mintingTokens(4_000);
	pointAt(`redis://${OBJECT_ID}@127.0.0.1:${server.port}`);
	const first = await getRedis();
	expect(first).not.toBeNull();
	// The first refresh, half-way through the token's life, cannot connect.
	const refused = spyOn(
		RedisClient.prototype,
		"connect",
	).mockImplementationOnce(async () => {
		throw new Error("refused");
	});
	try {
		await sleep(2_300);
		expect(refused).toHaveBeenCalledTimes(1);
		expect(server.dials()).toBe(1);
		expect(await getRedis()).toBe(first);
		// Half of what was left: dialled again, and replaced with time to spare.
		await sleep(1_300);
		expect(server.dials()).toBe(2);
		const second = await getRedis();
		expect(second).not.toBe(first);
		expect(await second?.send("PING", [])).toBe("OK");
	} finally {
		refused.mockRestore();
	}
}, 10_000);

test("assertRedisReachable: nothing configured is nothing to assert", async () => {
	pointAt(undefined);
	await expect(assertRedisReachable()).resolves.toBeUndefined();
});

test("assertRedisReachable refuses a configured Redis that does not answer the dial, naming the host and the credential", async () => {
	const closed = startFakeRedisServer();
	closed.stop();
	pointAt(`redis://:secret@127.0.0.1:${closed.port}`);
	const failure = await assertRedisReachable().then(
		() => null,
		(err: unknown) => err,
	);
	expect(failure).toBeInstanceOf(RedisUnreachableError);
	const refusal = failure as RedisUnreachableError;
	expect(refusal.host).toBe("127.0.0.1");
	expect(refusal.auth).toBe("password");
	expect(refusal.message).toMatch(/127\.0\.0\.1.*password in REDIS_URL/);
	expect(refusal.message).toMatch(/configuration, not an outage/);
});

test("assertRedisReachable passes a Redis that answers, and the connection it dialled is the one callers get", async () => {
	server = startFakeRedisServer();
	pointAt(server.url);
	await assertRedisReachable();
	expect(server.dials()).toBe(1);
	expect(await getRedis()).not.toBeNull();
	expect(server.dials()).toBe(1);
});
