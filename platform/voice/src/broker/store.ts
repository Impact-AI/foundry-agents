import type { SpokenItem } from "@platform/agent";
import { reportFailure } from "@platform/config";
import type { UsageSubject } from "@platform/metering";
import { getRedis } from "@platform/redis";
import type { VoiceKeys } from "./keys";
import { type EndReason, readInbox } from "./messages";

/**
 * A live session's state in Redis: who it is for, what has been said, and
 * the end the sweeper left for its owner.
 * It is what a replica other than the owner needs to settle a session
 * whose owner died. Every write carries the session's TTL; every read fails
 * soft, to null or empty, and the caller says what that means. Redis is
 * required for live voice — a session is never opened without it — so a
 * failure here is an outage mid-session, which degrades the session rather
 * than ending it.
 */

/** Who a session is for, written as it opens. */
export interface SessionRecord {
	subject: UsageSubject;
	resourceId: string;
	threadId: string;
	/** The replica that opened it, for the logs. */
	replica: string;
}

/** A transcript bigger than this is not kept: the snapshot before it stands. */
export const MAX_SPOKEN_BYTES = 256 * 1024;

export interface SessionStore {
	write(record: SessionRecord): Promise<boolean>;
	read(): Promise<SessionRecord | null>;
	keepSpoken(spoken: readonly SpokenItem[]): Promise<void>;
	spoken(): Promise<SpokenItem[]>;
	/** Leave an end for the owner to find at its next heartbeat. False when Redis did not take it. */
	askEnd(reason: EndReason): Promise<boolean>;
	/** The end left for the owner, or null: none, or Redis did not say. */
	endAsked(): Promise<EndReason | null>;
	/** Everything of the session gone: it is settled. */
	forget(): Promise<void>;
}

type Redis = NonNullable<Awaited<ReturnType<typeof getRedis>>>;

/** The session `id`'s store; everything it writes lives `ttlMs`. */
export function sessionStore(
	keys: VoiceKeys,
	id: string,
	ttlMs: number,
): SessionStore {
	const run = async <T>(
		what: string,
		command: (redis: Redis) => Promise<T>,
	): Promise<T | null> => {
		const redis = await getRedis();
		if (!redis) return null;
		try {
			return await command(redis);
		} catch (err) {
			reportFailure("voice", `a live session could not ${what}`, err);
			return null;
		}
	};
	return {
		async write(record: SessionRecord): Promise<boolean> {
			return run("write the session", (redis) =>
				redis.send("EVAL", [
					"redis.call('HSET', KEYS[1], 'subject', ARGV[1], 'resourceId', ARGV[2], 'threadId', ARGV[3], 'replica', ARGV[4]) return redis.call('PEXPIRE', KEYS[1], ARGV[5])",
					"1",
					keys.session(id),
					record.subject,
					record.resourceId,
					record.threadId,
					record.replica,
					String(ttlMs),
				]),
			).then((reply) => reply !== null);
		},

		async read(): Promise<SessionRecord | null> {
			const values = await run("read the session", (redis) =>
				redis.send("HMGET", [
					keys.session(id),
					"subject",
					"resourceId",
					"threadId",
					"replica",
				]),
			);
			if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
				return null;
			const [subject, resourceId, threadId, replica] = values as string[];
			return {
				subject: subject as UsageSubject,
				resourceId: resourceId as string,
				threadId: threadId as string,
				replica: replica as string,
			};
		},

		async keepSpoken(spoken: readonly SpokenItem[]): Promise<void> {
			const value = JSON.stringify(spoken);
			if (Buffer.byteLength(value) > MAX_SPOKEN_BYTES) return;
			await run("keep the transcript", (redis) =>
				redis.send("SET", [keys.spoken(id), value, "PX", String(ttlMs)]),
			);
		},

		async spoken(): Promise<SpokenItem[]> {
			const raw = await run("read the transcript", (redis) =>
				redis.get(keys.spoken(id)),
			);
			if (typeof raw !== "string") return [];
			try {
				const parsed: unknown = JSON.parse(raw);
				return Array.isArray(parsed) ? (parsed as SpokenItem[]) : [];
			} catch {
				return [];
			}
		},

		async askEnd(reason: EndReason): Promise<boolean> {
			const reply = await run("leave the end for its owner", (redis) =>
				redis.send("SET", [
					keys.end(id),
					JSON.stringify({ type: "end", reason }),
					"PX",
					String(ttlMs),
				]),
			);
			return reply === "OK";
		},

		async endAsked(): Promise<EndReason | null> {
			const raw = await run("read the end left for it", (redis) =>
				redis.get(keys.end(id)),
			);
			return typeof raw === "string" ? (readInbox(raw)?.reason ?? null) : null;
		},

		async forget(): Promise<void> {
			await run("forget the session", (redis) =>
				redis.send("DEL", [keys.session(id), keys.spoken(id), keys.end(id)]),
			);
		},
	};
}
