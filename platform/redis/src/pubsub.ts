import {
	DEFAULT_REFRESH_MARGIN_MS,
	processSingleton,
	resetSingleton,
	withDeadline,
} from "@platform/config";
import type { RedisClient } from "bun";
import { resolveRedisAuth } from "./client/auth";
import { dialClient, getRedis } from "./client/connection";
import { commandTimeoutMs, retryCooldownMs } from "./client/options";
import { reportRedisFailure } from "./client/report";

/**
 * Channels across the fleet: a message published on one replica reaches
 * every replica subscribed to its channel, which is how a request served on
 * one replica reaches state another holds without a sticky session.
 *
 * Pub/sub is at most once. A message published while nobody listens, or
 * while a subscriber's connection is down, is gone: a caller sends over it
 * only what can be lost — a state change somebody else also records, or a
 * request with a deadline of its own — and `publish` says how many heard it,
 * so a caller can tell "nobody is there" from "delivered".
 *
 * A subscriber holds a connection of its own: a subscribed connection runs
 * no other command, so the shared client is never one. The process keeps one
 * subscriber connection for every channel, redials it after the cooldown
 * when it drops and subscribes it to every channel again, and replaces it
 * before an Entra token expires. While the replacement is being subscribed
 * both connections hear the channel, so a message published in that moment
 * can be heard twice: a listener takes a repeat as it takes a loss. Every
 * SUBSCRIBE is held to the command deadline, and a connection that does not
 * answer one is dropped and redialled — a channel the server refuses
 * included, since the client settles a SUBSCRIBE only when it is confirmed,
 * so the identity's access must cover every channel the process listens
 * on. Nothing here throws for Redis:
 * without one, or one that does not answer, the answer is null, and the
 * caller names its fallback.
 */

export type MessageListener = (message: string) => void;

export interface Subscription {
	/** Stop hearing the channel. Idempotent. */
	close(): Promise<void>;
}

interface Subscriber {
	client: RedisClient | null;
	dialling: Promise<RedisClient | null> | null;
	channels: Map<string, Set<MessageListener>>;
	/** The pending redial after a loss or a failed dial. */
	retry?: ReturnType<typeof setTimeout>;
	/** The Entra form only: the planned replacement before the token expires. */
	refresh?: ReturnType<typeof setTimeout>;
}

const SINGLETON = "redis:subscriber";
/** Never redial faster than this, whatever the cooldown says. */
const MIN_REDIAL_MS = 250;

function subscriber(): Subscriber {
	return processSingleton<Subscriber>(SINGLETON, () => ({
		client: null,
		dialling: null,
		channels: new Map(),
	}));
}

/** Hand one message to everybody listening on its channel in this process. */
function dispatch(s: Subscriber, message: string, channel: string): void {
	for (const listener of [...(s.channels.get(channel) ?? [])])
		try {
			listener(message);
		} catch (err) {
			// One listener's fault is not the channel's.
			reportRedisFailure(`a listener on "${channel}" failed`, err);
		}
}

/** The channels each connection is subscribed to, so none is subscribed twice. */
const heard = new WeakMap<RedisClient, Set<string>>();

async function listen(
	s: Subscriber,
	client: RedisClient,
	channel: string,
): Promise<void> {
	const channels = heard.get(client) ?? new Set<string>();
	heard.set(client, channels);
	if (channels.has(channel)) return;
	channels.add(channel);
	const timeout = commandTimeoutMs();
	try {
		await withDeadline(
			() =>
				client.subscribe(channel, (message, from) =>
					dispatch(s, message, from),
				),
			timeout,
			() => new Error(`SUBSCRIBE timed out after ${timeout}ms`),
		);
	} catch (err) {
		channels.delete(channel);
		throw err;
	}
}

/** A connection subscribed to every channel the process listens on, or null. */
async function connect(s: Subscriber): Promise<RedisClient | null> {
	if (s.client?.connected) return s.client;
	if (s.dialling) return s.dialling;
	const auth = resolveRedisAuth();
	if (!auth) return null;
	let attempt: Promise<RedisClient | null> | null = null;
	attempt = (async () => {
		let dialled: RedisClient | undefined;
		try {
			const { client, tokenExpiresAt } = await dialClient(auth);
			dialled = client;
			for (const channel of s.channels.keys()) await listen(s, client, channel);
			// A `closeSubscriber` while this dial was out has moved on: the
			// connection belongs to nobody.
			if (s.dialling !== attempt) {
				client.close();
				return null;
			}
			client.onclose = () => lost(s, client);
			s.client = client;
			if (tokenExpiresAt !== undefined) planRefresh(s, client, tokenExpiresAt);
			return client;
		} catch (err) {
			// A connection that refused a channel, or never answered for one,
			// is not kept half subscribed.
			dialled?.close();
			reportRedisFailure("the subscriber's dial failed", err);
			if (s.dialling === attempt) retryLater(s);
			return null;
		} finally {
			if (s.dialling === attempt) s.dialling = null;
		}
	})();
	s.dialling = attempt;
	return attempt;
}

/** The connection dropped: the channels are heard again once it is redialled. */
function lost(s: Subscriber, client: RedisClient): void {
	if (s.client !== client) return;
	s.client = null;
	reportRedisFailure(
		"the subscriber's connection was lost; redialling",
		new Error("connection closed"),
	);
	retryLater(s);
}

/**
 * A redial after the cooldown. Its timer is its own: the planned refresh of
 * a token is pending for the whole life of an Entra connection, and a loss
 * must be redialled all the same.
 */
function retryLater(s: Subscriber): void {
	if (s.retry || s.channels.size === 0) return;
	s.retry = setTimeout(
		() => {
			s.retry = undefined;
			if (s.channels.size) void connect(s);
		},
		Math.max(retryCooldownMs(), MIN_REDIAL_MS),
	);
	s.retry.unref?.();
}

/**
 * A fresh connection before the token expires, subscribed before the old one
 * is closed. A replacement that cannot be dialled leaves the old connection
 * serving and is tried again, sooner each time, for as long as the token
 * has left; past its expiry the server drops the connection, which is a
 * loss the redial answers.
 */
function planRefresh(s: Subscriber, client: RedisClient, expiresAt: number) {
	const remaining = expiresAt - Date.now();
	const delay = Math.max(
		remaining - DEFAULT_REFRESH_MARGIN_MS,
		remaining / 2,
		MIN_REDIAL_MS,
	);
	clearTimeout(s.refresh);
	s.refresh = setTimeout(async () => {
		s.refresh = undefined;
		if (s.client !== client) return;
		// Forgotten first, so `connect` dials rather than answering with it.
		s.client = null;
		const next = await connect(s);
		if (next) {
			// No longer the subscriber's, so its close is not a loss.
			client.close();
			return;
		}
		if (s.client === null && client.connected) {
			s.client = client;
			// Half of what the token has left, each time: a mint that failed once is asked again before the expiry, not at it.
			if (expiresAt > Date.now()) planRefresh(s, client, expiresAt);
		} else client.close();
	}, delay);
	s.refresh.unref?.();
}

/**
 * Hear `channel` until the subscription is closed. Null without Redis, or
 * when the subscriber cannot be dialled or refuses the channel.
 */
export async function subscribe(
	channel: string,
	listener: MessageListener,
): Promise<Subscription | null> {
	const s = subscriber();
	let listeners = s.channels.get(channel);
	if (!listeners) {
		listeners = new Set();
		s.channels.set(channel, listeners);
	}
	listeners.add(listener);
	const forget = () => {
		const held = s.channels.get(channel);
		held?.delete(listener);
		if (held && held.size === 0) {
			s.channels.delete(channel);
			return true;
		}
		return false;
	};
	const client = await connect(s);
	if (!client) {
		forget();
		return null;
	}
	try {
		// A dial made after the channel was added has subscribed to it already.
		await listen(s, client, channel);
	} catch (err) {
		reportRedisFailure(`subscribe to "${channel}" failed`, err);
		forget();
		// A connection that did not answer cannot be trusted with the other
		// channels either: dropped, and redialled for them. A channel the
		// server refuses ends the same way: the client settles a SUBSCRIBE
		// only on its confirmation, so a refusal is a deadline passed.
		if (s.client === client) {
			s.client = null;
			client.close();
			retryLater(s);
		}
		return null;
	}
	let closed = false;
	return {
		async close() {
			if (closed) return;
			closed = true;
			const current = s.client;
			if (!forget() || !current?.connected) return;
			heard.get(current)?.delete(channel);
			try {
				await current.unsubscribe(channel);
			} catch (err) {
				reportRedisFailure(`unsubscribe from "${channel}" failed`, err);
			}
		},
	};
}

/**
 * Send `message` to everybody subscribed to `channel`, fleet-wide: how many
 * heard it, or null when Redis did not answer.
 */
export async function publish(
	channel: string,
	message: string,
): Promise<number | null> {
	const redis = await getRedis();
	if (!redis) return null;
	try {
		return await redis.publish(channel, message);
	} catch (err) {
		reportRedisFailure(`publish to "${channel}" failed`, err);
		return null;
	}
}

/** Drop the subscriber's connection and every subscription. For tests and shutdown. */
export function closeSubscriber(): void {
	const s = subscriber();
	clearTimeout(s.retry);
	clearTimeout(s.refresh);
	// A dial in flight finds it is no longer the subscriber's and closes itself.
	s.dialling = null;
	const client = s.client;
	// Forgotten first, so its close is not read as a loss to redial.
	s.client = null;
	s.channels.clear();
	resetSingleton(SINGLETON);
	client?.close();
}
