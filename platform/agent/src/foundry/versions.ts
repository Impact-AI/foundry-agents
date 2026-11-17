import { withLock } from "@platform/redis";
import type { AgentKeys } from "../keys";
import {
	type AgentKind,
	createAgentVersion,
	hasStatus,
	kindOptions,
	projectClient,
} from "./client";
import { definitionHash } from "./definition";

/**
 * One agent version per definition, made once for the whole fleet. A
 * version is found by its hash: in this replica's memory, then the fleet's
 * memo, then by asking the service, whose versions carry the hash in their
 * metadata. The service's listing of an agent's versions can trail a
 * version just made by minutes while a read of that version by its number
 * answers at once, so the numbers past the newest listed are read one by
 * one too: a version the job made a moment ago, without the memo, is found
 * by the backend's start rather than made again. Only one replica asks the
 * service to make a version for a hash at a time — the rest wait for its
 * answer on the memo — so a deploy that changes the persona under a burst
 * of turns makes one version, not one per replica. A second version of one
 * definition is harmless: the newest is the one found, and the job's prune
 * tidies the rest. A voice agent's versions are found and made the same
 * way, with the preview opt-in on every call.
 */

/** How long a found version is shared across the fleet: a hash names one version for ever. */
const MEMO_TTL_SECONDS = 86_400;
/** Longer than the slowest create the service has been seen to take. */
const LOCK_TTL_MS = 60_000;
const WAIT_STEP_MS = 250;
/** The versions the service is asked through for a match, newest first. */
const SEARCH_DEPTH = 50;
/** The most versions past the newest listed that are read by number. */
const LISTING_LAG = 10;

/** A definition in the service's own field names, of either kind. */
type Definition = { kind: AgentKind };

export interface AgentVersions<D extends Definition = Definition> {
	/** The version for this definition, made when there is none. */
	ensure(definition: D): Promise<string>;
	/** Forget what every layer holds for this definition, for a version the service no longer has. */
	forget(definition: D): Promise<void>;
}

async function findVersion(
	name: string,
	kind: AgentKind,
	hash: string,
): Promise<string | null> {
	const agents = projectClient().agents;
	let seen = 0;
	let newest = 0;
	try {
		for await (const version of agents.listVersions(name, {
			order: "desc",
			...kindOptions(kind),
		})) {
			if (version.metadata?.hash === hash) return version.version;
			newest = Math.max(newest, Number(version.version) || 0);
			if (++seen >= SEARCH_DEPTH) break;
		}
	} catch (err) {
		// No agent of that name yet: the first version makes it.
		if (!hasStatus(err, 404)) throw err;
	}
	// The listing trails the versions just made, while each is read at once by its number: the
	// numbers past the newest listed are asked for one by one, up to the first that is not there.
	for (let ahead = 1; ahead <= LISTING_LAG; ahead++) {
		let version: Awaited<ReturnType<typeof agents.getVersion>>;
		try {
			version = await agents.getVersion(
				name,
				String(newest + ahead),
				kindOptions(kind),
			);
		} catch (err) {
			if (hasStatus(err, 404)) break;
			throw err;
		}
		if (version.metadata?.hash === hash) return version.version;
	}
	return null;
}

export function agentVersions<D extends Definition>(
	name: string,
	keys: AgentKeys,
	kind: D["kind"],
): AgentVersions<D> {
	const local = new Map<string, string>();
	const inflight = new Map<string, Promise<string>>();
	const memoName = (hash: string) => `agent-version:${name}:${hash}`;

	async function shared(hash: string): Promise<string | null> {
		const hit = await keys.memo.read<string>(memoName(hash));
		return typeof hit?.value === "string" ? hit.value : null;
	}

	async function make(definition: D, hash: string): Promise<string> {
		const found = await findVersion(name, kind, hash);
		if (found) return found;
		return createAgentVersion(name, definition, { hash });
	}

	async function resolve(definition: D, hash: string): Promise<string> {
		const memo = await shared(hash);
		if (memo) return memo;
		const locked = await withLock(
			{
				key: keys.namespace.key("agent-version-lock", name, hash),
				ttlMs: LOCK_TTL_MS,
				whenUnavailable: "run",
			},
			async () => {
				const version = await make(definition, hash);
				await keys.memo.write(memoName(hash), version, MEMO_TTL_SECONDS);
				return version;
			},
		);
		if (locked.ran) return locked.value;
		// Another replica is making it: its answer arrives on the memo.
		for (let waited = 0; waited < LOCK_TTL_MS; waited += WAIT_STEP_MS) {
			await Bun.sleep(WAIT_STEP_MS);
			const made = await shared(hash);
			if (made) return made;
		}
		return make(definition, hash);
	}

	return {
		async ensure(definition) {
			const hash = definitionHash(definition);
			const held = local.get(hash);
			if (held) return held;
			let pending = inflight.get(hash);
			if (!pending) {
				pending = resolve(definition, hash).finally(() =>
					inflight.delete(hash),
				);
				inflight.set(hash, pending);
			}
			const version = await pending;
			local.set(hash, version);
			return version;
		},
		async forget(definition) {
			const hash = definitionHash(definition);
			local.delete(hash);
			await keys.memo.drop(memoName(hash));
		},
	};
}

/**
 * The job's prune: every version of the agent but the newest `keep` and the
 * ones `pinned` names, oldest first. A version a replica still pins answers
 * its next turn with a 404 and the replica makes it again, so a prune can
 * never strand a turn for longer than one retry; `pinned` is for the
 * versions the job has just made current — the voice agent's one per
 * engine — which a run of the other engine's versions must not push out;
 * `inUse` is asked about each version the prune would delete, and keeps one
 * a live session may still be running on (a voice tester's, on a version of
 * its own).
 */
export async function pruneVersions(
	name: string,
	keep: number,
	kind: AgentKind = "prompt",
	pinned: readonly string[] = [],
	inUse: (version: string) => Promise<boolean> = async () => false,
): Promise<number> {
	const agents = projectClient().agents;
	const options = kindOptions(kind);
	const versions: string[] = [];
	try {
		for await (const version of agents.listVersions(name, {
			order: "desc",
			...options,
		}))
			versions.push(version.version);
	} catch (err) {
		// No agent of that name: nothing to prune.
		if (!hasStatus(err, 404)) throw err;
	}
	const held = new Set(pinned);
	let deleted = 0;
	for (const version of versions.slice(keep)) {
		if (held.has(version) || (await inUse(version))) continue;
		await agents.deleteVersion(name, version, options);
		deleted++;
	}
	return deleted;
}
