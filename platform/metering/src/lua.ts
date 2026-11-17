/**
 * Lua every script in this package shares, as fragments concatenated at the
 * front of a script. A fragment defines a local and nothing else, so the
 * script that follows reads as if it had written the line itself.
 */

/**
 * `now`: the server's clock in milliseconds, from `TIME`, never a replica's.
 * A replica-supplied stamp has to be guarded against arriving from the
 * future, and one clock for every script means two replicas never disagree
 * about what is due. A stamp a replica writes into a record (a session's
 * start, and the deadline counted from it) is still that replica's clock,
 * so a session ends early or late by that replica's skew from the server. `TIME` is non-deterministic, and a server before 5 refuses it in
 * a script that writes unless effects rather than text are replicated; from
 * 5 on this is the default and the call is a no-op. The existence check
 * keeps the script loadable on a server that has dropped the function.
 */
export const NOW_MS = `
if redis.replicate_commands then redis.replicate_commands() end
local when = redis.call('TIME')
local now = (tonumber(when[1]) * 1000) + (tonumber(when[2]) / 1000)
`;

/** `field(fields, name)`: one value out of a flat HGETALL reply, or nil. */
export const FIELD = `
local function field(fields, name)
  for i = 1, #fields, 2 do
    if fields[i] == name then return fields[i + 1] end
  end
  return nil
end
`;
