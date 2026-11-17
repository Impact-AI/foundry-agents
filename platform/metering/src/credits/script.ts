import { NOW_MS } from "../lua";

/**
 * The credit bucket, as the server runs it, and the arithmetic around it.
 *
 * A credit is this limiter's own unit and never a model token: one call, or
 * one second of realtime. The algorithm is the classic token bucket, spelled
 * in credits because this package sits beside code that meters model tokens
 * and the two units in one file are expensive to confuse.
 *
 * KEYS[1] = the bucket hash; ARGV = capacity, refill per second, amount,
 * mode. Returns {allowed, retryAfterSeconds}, retry being how long until
 * `amount` credits exist again at the given rate.
 *
 * The clock is the server's (`TIME`), never a replica's. A replica-supplied
 * stamp has to be guarded against arriving from the future, and a guard that
 * resets the bucket hands a lagging replica a free refill precisely under the
 * burst a limiter exists for; one clock for every caller makes skew stop
 * existing as a concept.
 *
 * A refund and a peek are modes, not a negative or a zero amount: the debit
 * path must be able to refuse a non-positive cost as unbounded, so direction
 * is an explicit argument and each path clamps its own. A refund clamps at
 * capacity on the way up, because the stored count is readable through a
 * peek and must never say more than the bucket holds. A peek writes nothing —
 * not the refilled count, not the stamp, not a key — so asking creates no
 * state.
 */
export const CREDIT_BUCKET = `${NOW_MS}
local data = redis.call('HMGET', KEYS[1], 't', 'ts')
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local amount = tonumber(ARGV[3])
local refund = ARGV[4] == 'refund'
local peek = ARGV[4] == 'peek'
local credits = tonumber(data[1])
local ts = tonumber(data[2])

if credits == nil or ts == nil then
  -- No bucket yet, or fields that will not parse: a first caller gets a full
  -- bucket, which is what capacity means.
  credits = cap
  ts = now
elseif now < ts then
  -- A stamp from the future, which one server's clock cannot produce but a
  -- failover to a node whose clock sits behind, or a hand edit, can. Keep the
  -- credits and count the elapsed time as zero: a clock moving backwards
  -- costs the caller nothing and buys them nothing.
  ts = now
end

credits = math.min(cap, credits + ((now - ts) / 1000) * rate)
local allowed = 0
local retry = 0
if refund then
  credits = math.min(cap, credits + amount)
  allowed = 1
elseif credits >= amount then
  if not peek then credits = credits - amount end
  allowed = 1
else
  retry = math.ceil((amount - credits) / rate)
end
if not peek then
  redis.call('HSET', KEYS[1], 't', credits, 'ts', now)
  redis.call('PEXPIRE', KEYS[1], math.ceil((cap / rate) * 2000))
end
return {allowed, retry}
`;

export type BucketMode = "spend" | "refund" | "peek";

export interface CreditPolicy {
	/** What the bucket holds: the burst a quiet caller may spend at once. */
	capacity: number;
	/** Credits added per minute. */
	refillPerMinute: number;
}

export interface CreditVerdict {
	allowed: boolean;
	/** Seconds until the request would fit; zero when it was allowed. */
	retryAfterSeconds: number;
}

const MINUTES_PER_DAY = 1440;

/** A rolling day: the whole allowance, refilled continuously. */
export function rollingDay(allowance: number): CreditPolicy {
	return { capacity: allowance, refillPerMinute: allowance / MINUTES_PER_DAY };
}

/**
 * What one request spends, given what the caller asked for. Never below 1: a
 * zero or negative cost is not a cheap request but an unbounded one, and a
 * NaN would lose every comparison in the script and refuse the route for
 * ever. Never above capacity: a cost the bucket cannot hold is a route that
 * can never be admitted, and clamping turns that into one request that
 * empties the bucket, which an operator can at least see. That holds for a
 * capacity below one credit too, which a full bucket then pays whole.
 *
 * A caller that later refunds what it charged must not rely on the clamp:
 * what was taken is then less than what it asked for (see `chargeSeconds`).
 */
export function clampCost(cost: number, capacity: number): number {
	const ceiling = Number.isFinite(capacity) && capacity > 0 ? capacity : 1;
	if (!Number.isFinite(cost) || cost < 1) return Math.min(1, ceiling);
	return Math.min(cost, ceiling);
}

/**
 * What a refund returns; `0` means do not run the script. Zero and below is
 * a no-op rather than a floor of one, because "nothing went unused" is an
 * ordinary settlement and crediting one back would inflate every bucket by a
 * credit per session. A non-finite amount is dropped rather than stored as
 * NaN. Capacity is the ceiling, as it is in the script.
 */
export function clampRefund(credits: number, capacity: number): number {
	const ceiling = Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
	if (!Number.isFinite(credits) || credits <= 0) return 0;
	return Math.min(credits, ceiling);
}
