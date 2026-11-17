import { FIELD, NOW_MS } from "../lua";

/**
 * The ledger's scripts, beside each other so their contract reads as one.
 * Every key they take shares one hash tag (see ../keys), so a cluster runs
 * them. The time a script needs is the server's (`TIME`), as the bucket's is.
 */

/**
 * Take the subject's lock and, only if it held, write the session down and
 * put its deadline on the sweeper's list — one step, so the lock and the
 * record never disagree about whether a session exists. `SET NX` is the
 * whole concurrency decision; its value is the session's id, which lets a
 * claim release only the lock it owns.
 *
 * KEYS = record, deadline set, lock. ARGV = id, subject, callId, startedAt,
 * debitedSeconds, deadlineAt, record TTL, lock TTL, hardDeadlineAt, endReason,
 * ownDay.
 * Returns 1 when recorded, 0 when the lock was held.
 *
 * The deadline set's own TTL is raised to the record's whenever that is
 * longer, and never lowered: a set that expired mid-session would read as an
 * empty deployment, and one nothing has written to for a record's whole life
 * holds nothing live.
 */
export const RECORD = `
if redis.call('SET', KEYS[3], ARGV[1], 'NX', 'EX', ARGV[8]) == false then
  return 0
end
redis.call('HSET', KEYS[1],
  'subject', ARGV[2], 'callId', ARGV[3], 'startedAt', ARGV[4],
  'debitedSeconds', ARGV[5], 'deadlineAt', ARGV[6],
  'hardDeadlineAt', ARGV[9], 'endReason', ARGV[10], 'ownDay', ARGV[11])
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('ZADD', KEYS[2], ARGV[6], ARGV[1])
if redis.call('TTL', KEYS[2]) < tonumber(ARGV[7]) then
  redis.call('EXPIRE', KEYS[2], ARGV[7])
end
return 1
`;

/**
 * Move a session's deadline, guarded on the deadline the caller read, so two
 * renewals that race buy one extension between them. The same script writes
 * the "remember why" note of a refused renewal, with the deadline unmoved.
 *
 * KEYS = record, deadline set. ARGV = id, subject, the deadline read, the
 * deadline wanted, the seconds bought, the end reason to store, and whether
 * those seconds drew on the subject's own day. Returns 1
 * when applied, 0 when the record was gone, not this subject's, or moved.
 * No TTL is touched: the record's and the lock's were sized off the hard
 * ceiling, which a renewal never passes.
 */
export const RENEW = `${FIELD}
local fields = redis.call('HGETALL', KEYS[1])
if #fields == 0 then return 0 end
if field(fields, 'subject') ~= ARGV[2] or field(fields, 'deadlineAt') ~= ARGV[3] then
  return 0
end
redis.call('HSET', KEYS[1], 'deadlineAt', ARGV[4], 'endReason', ARGV[6])
if tonumber(ARGV[5]) > 0 then
  redis.call('HINCRBY', KEYS[1], 'debitedSeconds', ARGV[5])
  redis.call('HSET', KEYS[1], 'ownDay', ARGV[7])
end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
return 1
`;

/**
 * Release the subject's lock in the same step as the claim that settles —
 * and only if the lock still names this session, so a claim arriving after
 * the lock expired and was retaken leaves the newer session's lock alone.
 * The same owner guard as \`@platform/redis\`'s claim release, inlined
 * because it has to run inside the claim's own step.
 */
const RELEASE_LOCK = `
local function release(prefix, fields, id)
  local subject = field(fields, 'subject')
  if subject == nil then return end
  local lock = prefix .. subject
  if redis.call('GET', lock) == id then redis.call('DEL', lock) end
end
`;

/**
 * Take one named session out of the ledger, atomically, and only if it is
 * ARGV[1]'s. The read, the ZREM and the DEL are one script so two callers
 * cannot both see the record: whichever claims it settles it, and a replayed
 * end, a racing sweeper or a second replica finds nothing. That DEL is the
 * whole of the double-settlement defence.
 *
 * KEYS = record, deadline set, lock prefix. ARGV = subject, id. Returns the
 * hash as a flat field list, or false.
 */
export const CLAIM_ONE = `${FIELD}${RELEASE_LOCK}
local fields = redis.call('HGETALL', KEYS[1])
if #fields == 0 then return false end
if field(fields, 'subject') ~= ARGV[1] then return false end
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
release(KEYS[3], fields, ARGV[2])
return fields
`;

/**
 * The same, for the earliest session whose deadline has passed. Before it
 * returns it leaves the ended note holding the record's reason and subject,
 * in the same step as the DEL, so a beacon arriving after the cutoff reads
 * which cutoff it was and never "unknown" — "nothing" is also the answer for
 * an id that never existed, and that has to stay a 404.
 *
 * KEYS = deadline set, record prefix, note prefix, lock prefix. ARGV = the
 * note's TTL in seconds. Returns the id followed by the fields, or false
 * when nothing is due. An entry whose record has already expired answers
 * with its id alone: it is removed, and the caller goes on to the next.
 */
export const CLAIM_DUE = `${FIELD}${RELEASE_LOCK}${NOW_MS}
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)
if #due == 0 then return false end
local id = due[1]
redis.call('ZREM', KEYS[1], id)
local key = KEYS[2] .. id
local fields = redis.call('HGETALL', key)
redis.call('DEL', key)
if #fields == 0 then return { id } end
local subject = field(fields, 'subject')
local reason = field(fields, 'endReason')
if subject ~= nil and reason ~= nil then
  redis.call('SET', KEYS[3] .. id, reason .. ':' .. subject, 'EX', ARGV[1])
end
release(KEYS[4], fields, id)
return { id, unpack(fields) }
`;
