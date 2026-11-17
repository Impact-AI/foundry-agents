import { getRedis } from "./client/connection";
import { checkedReply, isOkOrNil, isStringOrNil } from "./client/reply";
import { reportRedisFailure } from "./client/report";

/**
 * A key one owner holds for a while. The first `claimOnce` within the TTL
 * wins, later ones learn who holds it, and only the holder may release it,
 * so a claim that expired and was taken elsewhere is never
 * clobbered by its previous owner. The owner is the caller's name for itself,
 * a replica or a run, and is what lets a retry recognise its own claim.
 *
 * Nothing here throws for Redis: without one, or when a claim's own answer
 * is not had, the answer is `unavailable`, and the caller decides what
 * uncoordinated means for it. A claim whose reply was lost may have landed:
 * it then reads as `held` to everybody, its maker included, until it expires.
 */

export type ClaimOutcome =
	| { outcome: "claimed" }
	| { outcome: "held"; owner: string | null }
	| { outcome: "unavailable" };

export type ReleaseOutcome = "released" | "not-held" | "unavailable";

/** A claim's value is its owner's name, and a name is short. */
export const MAX_OWNER_BYTES = 256;

const RELEASE_IF_OWNER =
	'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const UNAVAILABLE = { outcome: "unavailable" } as const;

export async function claimOnce(
	key: string,
	owner: string,
	ttlMs: number,
): Promise<ClaimOutcome> {
	checkOwner(owner);
	checkTtl(ttlMs);
	const redis = await getRedis();
	if (!redis) return UNAVAILABLE;
	try {
		const set = checkedReply(
			"SET NX",
			await redis.send("SET", [key, owner, "NX", "PX", String(ttlMs)]),
			isOkOrNil,
		);
		if (set === "OK") return { outcome: "claimed" };
	} catch (err) {
		reportRedisFailure(`claim of "${key}" failed; uncoordinated`, err);
		return UNAVAILABLE;
	}
	// Refused: somebody holds it, whether or not Redis then says who. A
	// failed read of the holder is still `held`, never `unavailable`, which a
	// caller may answer by going ahead uncoordinated beside the holder.
	try {
		const holder = checkedReply("GET", await redis.get(key), isStringOrNil);
		return { outcome: "held", owner: holder };
	} catch (err) {
		reportRedisFailure(`read of the holder of "${key}" failed`, err);
		return { outcome: "held", owner: null };
	}
}

/**
 * Who holds the claim, without taking it: for a caller that must step aside
 * while somebody holds a key, and claims nothing of its own.
 */
export async function claimHolder(
	key: string,
): Promise<
	{ outcome: "held"; owner: string } | { outcome: "free" } | typeof UNAVAILABLE
> {
	const redis = await getRedis();
	if (!redis) return UNAVAILABLE;
	try {
		const owner = checkedReply("GET", await redis.get(key), isStringOrNil);
		return owner === null ? { outcome: "free" } : { outcome: "held", owner };
	} catch (err) {
		reportRedisFailure(`read of claim "${key}" failed; uncoordinated`, err);
		return UNAVAILABLE;
	}
}

const EXTEND_IF_OWNER =
	'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

export type ExtendOutcome = "extended" | "not-held" | "unavailable";

/**
 * Give the claim `ttlMs` more from now, while `owner` still holds it: the
 * heartbeat of an owner that holds a key for as long as it lives, so a
 * holder that died is known by its claim lapsing.
 */
export async function extendClaim(
	key: string,
	owner: string,
	ttlMs: number,
): Promise<ExtendOutcome> {
	checkTtl(ttlMs);
	const redis = await getRedis();
	if (!redis) return "unavailable";
	try {
		const reply = await redis.send("EVAL", [
			EXTEND_IF_OWNER,
			"1",
			key,
			owner,
			String(ttlMs),
		]);
		return reply === 1 ? "extended" : "not-held";
	} catch (err) {
		reportRedisFailure(`extension of "${key}" failed`, err);
		return "unavailable";
	}
}

/** Delete the claim, while `owner` still holds it; the TTL deletes it otherwise. */
export async function releaseClaim(
	key: string,
	owner: string,
): Promise<ReleaseOutcome> {
	const redis = await getRedis();
	if (!redis) return "unavailable";
	try {
		const reply = await redis.send("EVAL", [RELEASE_IF_OWNER, "1", key, owner]);
		return reply === 1 ? "released" : "not-held";
	} catch (err) {
		reportRedisFailure(`release of "${key}" failed`, err);
		return "unavailable";
	}
}

function checkOwner(owner: string): void {
	if (owner === "" || Buffer.byteLength(owner) > MAX_OWNER_BYTES) {
		throw new RangeError(
			`a claim's owner is 1 to ${MAX_OWNER_BYTES} bytes, got ${Buffer.byteLength(owner)}`,
		);
	}
}

function checkTtl(ttlMs: number): void {
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
		throw new RangeError(
			`a claim's TTL is a positive integer of milliseconds, got ${ttlMs}`,
		);
	}
}
