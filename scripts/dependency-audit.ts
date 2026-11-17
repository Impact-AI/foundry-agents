/**
 * The lockfiles, asked what is known against what they hold.
 *
 * `bun audit` answers from the registry's advisories for exactly the
 * versions a lockfile pins, the root's and the site's. An advisory rated
 * high or critical fails the run unless it is in the accepted list beside
 * this file, where each entry says why what it names cannot be reached
 * here or is bounded another way. The list is held to the lockfile too: an
 * entry whose advisory the audit no longer reports fails the run until it
 * is taken out, so an exception does not outlive its reason.
 *
 * Moderate and low advisories are printed and do not fail: they are read,
 * not gated.
 *
 *   bun scripts/dependency-audit.ts
 */
import { join } from "node:path";

export interface Advisory {
	/** The advisory's id, as the registry's URL ends: `GHSA-…`. */
	id: string;
	package: string;
	severity: string;
	title: string;
	/** The versions it is against. */
	range: string;
}

export interface Accepted {
	id: string;
	package: string;
	/** The folder of the lockfile the entry is for: `.` or `site`. */
	lockfile: string;
	/** Why it is accepted: what is true here, and what would end it. */
	reason: string;
}

export interface Judgement {
	/** High or critical, and not accepted: these fail the run. */
	blocking: Advisory[];
	/** Accepted, and still reported. */
	accepted: Advisory[];
	/** Below the gate: printed only. */
	below: Advisory[];
	/** Accepted entries the audit no longer reports: these fail the run too. */
	stale: Accepted[];
}

/** The lockfiles audited, by folder from the repository root. */
export const LOCKFILES = [".", "site"] as const;

const GATED = new Set(["high", "critical"]);

/** What `bun audit --json` printed, as advisories; null for anything that is not its answer. */
export function readAudit(output: string): Advisory[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return null;
	const advisories: Advisory[] = [];
	for (const [name, found] of Object.entries(parsed)) {
		if (!Array.isArray(found)) return null;
		for (const entry of found) {
			const { url, severity, title, vulnerable_versions } = (entry ??
				{}) as Record<string, unknown>;
			const id = String(url ?? "")
				.split("/")
				.pop();
			if (!id || typeof severity !== "string") return null;
			advisories.push({
				id,
				package: name,
				severity,
				title: String(title ?? ""),
				range: String(vulnerable_versions ?? ""),
			});
		}
	}
	return advisories;
}

/** One lockfile's advisories against the entries accepted for it. */
export function judge(
	found: readonly Advisory[],
	accepted: readonly Accepted[],
): Judgement {
	const key = (entry: { id: string; package: string }) =>
		`${entry.package} ${entry.id}`;
	const allowed = new Set(accepted.map(key));
	const reported = new Set(found.map(key));
	return {
		blocking: found.filter(
			(a) => GATED.has(a.severity) && !allowed.has(key(a)),
		),
		accepted: found.filter((a) => allowed.has(key(a))),
		below: found.filter((a) => !GATED.has(a.severity) && !allowed.has(key(a))),
		stale: accepted.filter((a) => !reported.has(key(a))),
	};
}

const line = (a: Advisory) =>
	`  ${a.severity.padEnd(8)} ${a.package} ${a.range}  ${a.id}  ${a.title}`;

async function main(): Promise<number> {
	const root = join(import.meta.dir, "..");
	const accepted = (await Bun.file(
		join(import.meta.dir, "dependency-audit.accepted.json"),
	).json()) as Accepted[];
	let failed = false;
	for (const lockfile of LOCKFILES) {
		// The audit exits non-zero whenever it reports anything: what it printed is the answer.
		const run = Bun.spawnSync(["bun", "audit", "--json"], {
			cwd: join(root, lockfile),
			stdout: "pipe",
			stderr: "pipe",
		});
		const found = readAudit(run.stdout.toString());
		if (!found) {
			console.error(
				`${lockfile}/bun.lock: the audit gave no answer\n${run.stderr.toString()}`,
			);
			return 2;
		}
		const verdict = judge(
			found,
			accepted.filter((entry) => entry.lockfile === lockfile),
		);
		console.log(
			`${lockfile}/bun.lock: ${found.length} advisories — ${verdict.blocking.length} to fix, ${verdict.accepted.length} accepted, ${verdict.below.length} below the gate`,
		);
		for (const a of verdict.blocking) console.log(`FIX${line(a)}`);
		for (const a of verdict.accepted) console.log(`ok ${line(a)}`);
		for (const a of verdict.below) console.log(`   ${line(a)}`);
		for (const entry of verdict.stale)
			console.log(
				`STALE  ${entry.package} ${entry.id}: accepted, and no longer reported — take it out of dependency-audit.accepted.json`,
			);
		if (verdict.blocking.length || verdict.stale.length) failed = true;
	}
	return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
