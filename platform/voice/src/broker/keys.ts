import type { KeyNamespace } from "@platform/redis";

/**
 * Every key and channel a live session has in Redis, under the app's
 * namespace and hash-tagged by the session's id, so a script may touch
 * several of one session's keys at once. The session itself — both
 * sockets — lives on one replica; Redis carries only what another replica
 * needs when that one is gone or must be reached. Each key carries a TTL
 * sized off the session's hard limit, so a session nobody settled leaves
 * nothing behind for long:
 *
 *   - `owner`   the replica holding the session's sockets, renewed by its
 *               heartbeat: a lapsed claim is a dead owner, and it is the
 *               one thing the sweeper's hangup reads to tell a dead owner
 *               from one that did not hear it;
 *   - `session` who the session is for — subject, account, thread — read by
 *               the replica that settles a session whose owner died;
 *   - `spoken`  the transcript so far, so that settle writes what was said
 *               rather than nothing;
 *   - `end`     the sweeper's end, left for the owner: its heartbeat reads
 *               it, so an end the channel did not deliver still ends the
 *               session.
 *
 * One channel: `in` carries the same end to the owner at once, from
 * whichever replica's sweep found the session due. It is at most once,
 * which is why the end is also left under `end`.
 */
export interface VoiceKeys {
	owner(id: string): string;
	session(id: string): string;
	spoken(id: string): string;
	end(id: string): string;
	inbox(id: string): string;
}

export function voiceKeys(namespace: KeyNamespace): VoiceKeys {
	const key =
		(kind: string) =>
		(id: string): string =>
			namespace.tenantKey(id, "voice", kind);
	return {
		owner: key("owner"),
		session: key("session"),
		spoken: key("spoken"),
		end: key("end"),
		inbox: key("in"),
	};
}
