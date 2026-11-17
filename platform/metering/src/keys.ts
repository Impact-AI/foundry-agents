import {
	processSingleton,
	resetSingleton,
	setSingleton,
} from "@platform/config";
import { type KeyNamespace, keyNamespace } from "@platform/redis";
import type { UsageSubject } from "./subject";

/**
 * Every key this package writes, under one prefix an app may set once at
 * start-up. A subject's keys are hash-tagged on the subject; the ledger's are
 * tagged on one shared tag, because its scripts touch a record, the deadline
 * set and a lock in one step and a cluster refuses a script whose keys sit in
 * two slots. Every key carries a TTL where it is written.
 */

const DEFAULT_PREFIX = "metering";
const SINGLETON = "metering:keys";

/** The hash tag the ledger's keys share. */
const LIVE = "live";

export function meteringKeys(): KeyNamespace {
	return processSingleton(SINGLETON, () => keyNamespace(DEFAULT_PREFIX));
}

/** Put every key under `prefix` from now on. Once, at start-up, or in a test. */
export function setMeteringKeyPrefix(prefix: string): void {
	setSingleton(SINGLETON, keyNamespace(prefix));
}

/** Back to the default prefix. For tests. */
export function resetMeteringKeyPrefix(): void {
	resetSingleton(SINGLETON);
}

export const keys = {
	/** A subject's rolling daily allowance on one surface. */
	day: (subject: UsageSubject, surface: string) =>
		meteringKeys().tenantKey(subject, "day", surface),
	/** A subject's per-minute burst bucket on one surface. */
	burst: (subject: UsageSubject, surface: string) =>
		meteringKeys().tenantKey(subject, "burst", surface),
	/** A subject's daily realtime seconds. */
	seconds: (subject: UsageSubject) =>
		meteringKeys().tenantKey(subject, "seconds"),
	/** The deployment's realtime seconds for the day, drawn on by every subject. */
	pool: () => meteringKeys().key("pool", "realtime-seconds"),
	/** The sorted set of live sessions, scored by the deadline the sweeper ends each at. */
	deadlines: () => meteringKeys().tenantKey(LIVE, "deadlines"),
	/** A session record, under the opaque id the browser is given. */
	session: (id: string) => meteringKeys().tenantKey(LIVE, "session", id),
	/** What a script prepends to an id it read off the deadline set. */
	sessionPrefix: () => `${meteringKeys().tenantKey(LIVE, "session")}:`,
	/** The subject's one-live-session lock; its value is the session's id. */
	lock: (subject: UsageSubject) =>
		meteringKeys().tenantKey(LIVE, "lock", subject),
	lockPrefix: () => `${meteringKeys().tenantKey(LIVE, "lock")}:`,
	/** The sweeper's note on a session it ended: `{reason}:{subject}`. */
	ended: (id: string) => meteringKeys().tenantKey(LIVE, "ended", id),
	endedPrefix: () => `${meteringKeys().tenantKey(LIVE, "ended")}:`,
};

/** Whether an id a caller sent can be a key part at all. One that cannot is nobody's session. */
export function isKeyPart(id: string): boolean {
	try {
		meteringKeys().key(id);
		return true;
	} catch {
		return false;
	}
}
