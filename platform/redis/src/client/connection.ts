import {
	DEFAULT_REFRESH_MARGIN_MS,
	failureReason,
	processSingleton,
	resetSingleton,
	withDeadline,
} from "@platform/config";
import { RedisClient } from "bun";
import {
	describeRedisAuth,
	entraRedisUrl,
	type RedisAuth,
	redisTokenProvider,
	resolveRedisAuth,
} from "./auth";
import { withCommandDeadlines } from "./deadline";
import { commandTimeoutMs, connectTimeoutMs, retryCooldownMs } from "./options";
import { reportRedisFailure } from "./report";

/**
 * The process's one connection, and the contract every module above it keeps:
 * Redis is never required. `getRedis` answers null when none is configured,
 * when a dial failed recently and when the socket is down, and every caller
 * names its fallback for that null. A connection that is up but silent is the
 * one state a null cannot cover; the deadline on every command turns it into
 * the rejection the caller's `catch` was written for.
 *
 * One exception, drawn at startup: a Redis that is configured and was never
 * reachable is misconfiguration, not an outage, and `assertRedisReachable`
 * refuses to let the process serve on its fallbacks.
 */

interface Held {
	raw: RedisClient;
	bounded: RedisClient;
	/** The Entra form only: the planned redial before the token expires. */
	redial?: ReturnType<typeof setTimeout>;
}

interface Connection {
	held?: Held;
	dialling?: Promise<Held | null>;
	/** Epoch ms before which no dial is attempted. */
	coldUntil: number;
	/** Why the last dial failed, for the startup refusal. */
	lastFailure?: string;
}

const SINGLETON = "redis:connection";

/**
 * A token is redialled this long before it expires, but never sooner than
 * half-way through its life and never faster than this floor, so a credential
 * handing out short or already-expired tokens cannot turn the refresh into a
 * dial storm.
 */
const MIN_PLANNED_REDIAL_MS = 1_000;

function connection(): Connection {
	return processSingleton<Connection>(SINGLETON, () => ({ coldUntil: 0 }));
}

export function isRedisConfigured(): boolean {
	return resolveRedisAuth() !== undefined;
}

/**
 * The shared client with a deadline on every command, or null: not
 * configured, not reachable, or not connected right now. A lost socket is
 * discarded and redialled after the cooldown rather than left to the client's
 * own reconnect, so there is one reconnection mechanism and it is this one.
 */
export async function getRedis(): Promise<RedisClient | null> {
	const auth = resolveRedisAuth();
	if (!auth) return null;
	const c = connection();
	if (c.held) {
		if (c.held.raw.connected) return c.held.bounded;
		discard(c, c.held, "connection lost");
		c.coldUntil = Date.now() + retryCooldownMs();
		return null;
	}
	if (c.dialling) return (await c.dialling)?.bounded ?? null;
	if (Date.now() < c.coldUntil) return null;
	const attempt = dial(auth, c);
	c.dialling = attempt;
	const held = await attempt;
	// Only the attempt that is still current writes its outcome back; a
	// `closeRedis` in the meantime has already moved on.
	if (c.dialling === attempt) {
		c.dialling = undefined;
		if (held) c.held = held;
		else c.coldUntil = Date.now() + retryCooldownMs();
	}
	return held?.bounded ?? null;
}

/** A connected client, with when its token expires for the Entra form. */
export interface DialledClient {
	client: RedisClient;
	tokenExpiresAt?: number;
}

/**
 * One connection, dialled with the process's credential under the connect
 * timeout: the shared client's, and a connection a caller must hold to
 * itself — a subscriber, on which no other command may run. Throws as the
 * dial does, having closed a client that did not connect.
 */
export async function dialClient(auth: RedisAuth): Promise<DialledClient> {
	let url: string;
	let tokenExpiresAt: number | undefined;
	if (auth.mode === "entra") {
		const token = await redisTokenProvider()();
		url = entraRedisUrl(auth, token.token);
		tokenExpiresAt = token.expiresOnTimestamp;
	} else {
		url = auth.url;
	}
	const client = new RedisClient(url, {
		connectionTimeout: connectTimeoutMs(),
		// Reconnection is the caller's. Without a queue, a command issued
		// while the socket is down rejects at once instead of waiting for
		// its deadline.
		autoReconnect: false,
		enableOfflineQueue: false,
		// One command, one write, one reply. With commands batched by the
		// client, a reply was seen delivered to the command after its own,
		// which then waits out its deadline; known only from the client's
		// behaviour under this repository's suites.
		enableAutoPipelining: false,
	});
	const timeout = connectTimeoutMs();
	try {
		await withDeadline(
			() => client.connect(),
			timeout,
			() => new Error(`dial timed out after ${timeout}ms`),
		);
	} catch (err) {
		client.close();
		throw err;
	}
	return { client, tokenExpiresAt };
}

async function dial(auth: RedisAuth, c: Connection): Promise<Held | null> {
	try {
		const { client, tokenExpiresAt } = await dialClient(auth);
		const held: Held = {
			raw: client,
			bounded: withCommandDeadlines(client, {
				timeoutMs: commandTimeoutMs,
				onTimeout: (timeout) => discard(c, held, timeout.message),
			}),
		};
		if (tokenExpiresAt !== undefined) planRedial(auth, c, held, tokenExpiresAt);
		c.lastFailure = undefined;
		return held;
	} catch (err) {
		c.lastFailure = failureReason(err);
		reportRedisFailure("dial failed; callers fall back to their origins", err);
		return null;
	}
}

/**
 * The Entra form's token expires, so the connection is replaced by a fresh
 * dial before it does: a planned redial, not a failure, so no cooldown and no
 * fallback. The old connection is closed once the commands in flight on it
 * have had their deadline to answer. A planned redial that fails leaves the
 * connection standing and is tried again, sooner each time, for as long as
 * the token has left; past its expiry the server drops the connection,
 * `getRedis` sees the lost socket and the ordinary redial takes over.
 */
function planRedial(
	auth: RedisAuth,
	c: Connection,
	held: Held,
	expiresAt: number,
): void {
	const remaining = expiresAt - Date.now();
	const delay = Math.max(
		remaining - DEFAULT_REFRESH_MARGIN_MS,
		remaining / 2,
		MIN_PLANNED_REDIAL_MS,
	);
	held.redial = setTimeout(async () => {
		if (c.held !== held) return;
		const next = await dial(auth, c);
		if (c.held !== held) {
			if (next) closeLater(next);
			return;
		}
		if (!next) {
			console.error(
				"[redis] planned redial for a fresh token failed; the connection stays, and the redial is tried again while its token lasts",
			);
			// Half of what the token has left, each time: a mint that failed
			// once is asked again before the expiry, not at it.
			if (expiresAt > Date.now()) planRedial(auth, c, held, expiresAt);
			return;
		}
		c.held = next;
		closeLater(held);
	}, delay);
	held.redial.unref?.();
}

function closeLater(held: Held): void {
	if (held.redial) clearTimeout(held.redial);
	const timer = setTimeout(() => {
		try {
			held.raw.close();
		} catch {}
	}, commandTimeoutMs());
	timer.unref?.();
}

/**
 * Drop the connection so the next `getRedis` dials afresh. A command abandoned
 * at its deadline leaves a reply nobody consumes, and the client matches
 * replies to commands by arrival order, so keeping the socket would hand every
 * later caller the previous command's answer.
 */
function discard(c: Connection, held: Held, why: string): void {
	if (c.held !== held) return;
	c.held = undefined;
	console.error(
		`[redis] ${why}; dropping the connection, callers fall back to their origins until it is redialled`,
	);
	close(held);
}

function close(held: Held): void {
	if (held.redial) clearTimeout(held.redial);
	try {
		held.raw.close();
	} catch {}
}

/** Drop the connection because a reply cannot be trusted; `why` is logged. */
export function resetRedis(why: string): void {
	const c = connection();
	if (c.held) discard(c, c.held, why);
}

/**
 * Whether Redis answers right now: a PING under the command deadline. For a
 * caller whose next step fails closed while the ones before it fail open. One
 * round trip, so ask once per request, not per command.
 */
export async function redisAnswers(): Promise<boolean> {
	const redis = await getRedis();
	if (!redis) return false;
	try {
		await redis.ping();
		return true;
	} catch (err) {
		reportRedisFailure("ping failed", err);
		return false;
	}
}

export class RedisUnreachableError extends Error {
	readonly host: string;
	readonly auth: RedisAuth["form"];
	constructor(auth: RedisAuth, reason: string) {
		super(
			`Redis at ${auth.host}, dialled with ${describeRedisAuth(auth)}, is not reachable: ${reason}. ` +
				"A cache that was never reachable is configuration, not an outage: fix REDIS_URL, the network path or the identity's access policy, or unset REDIS_URL to run without a cache.",
		);
		this.name = "RedisUnreachableError";
		this.host = auth.host;
		this.auth = auth.form;
	}
}

/**
 * For a process's startup: when Redis is configured, one dial under the
 * connect timeout has to succeed, or the process refuses to serve. The
 * runtime fallbacks are for a Redis that goes away later, not for one that
 * was never there.
 */
export async function assertRedisReachable(): Promise<void> {
	const auth = resolveRedisAuth();
	if (!auth) return;
	if (await getRedis()) return;
	throw new RedisUnreachableError(
		auth,
		connection().lastFailure ?? "a dial failed within the retry cooldown",
	);
}

/**
 * Close the connection and forget the cooldown, so the next `getRedis` dials.
 * For tests and scripts, not for request paths.
 */
export async function closeRedis(): Promise<void> {
	const c = connection();
	resetSingleton(SINGLETON);
	const held = c.held ?? (await c.dialling);
	if (held) close(held);
}
