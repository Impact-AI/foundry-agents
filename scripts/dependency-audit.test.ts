import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type Accepted,
	type Advisory,
	judge,
	LOCKFILES,
	readAudit,
} from "./dependency-audit";
import accepted from "./dependency-audit.accepted.json";

/**
 * The audit's own reading and judging, on answers written here: the run
 * against the registry is the pipeline's, since what it reports changes
 * without the repository changing.
 */

const AUDIT = JSON.stringify({
	hono: [
		{
			id: 1,
			url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
			title: "A path is forwarded past its middleware",
			severity: "moderate",
			vulnerable_versions: "<4.13.16",
		},
	],
	undici: [
		{
			url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
			title: "Unbounded memory in a client",
			severity: "high",
			vulnerable_versions: "<6.24.0",
		},
		{
			url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii",
			title: "A certificate check is skipped",
			severity: "critical",
			vulnerable_versions: ">=4.0.0 <6.29.1",
		},
	],
});

const entry = (id: string, name: string): Accepted => ({
	id,
	package: name,
	lockfile: ".",
	reason: "Not reached here.",
});

test("the audit's answer is read as advisories, each under its package and its id; anything else is no answer", () => {
	expect(readAudit(AUDIT)).toEqual([
		{
			id: "GHSA-aaaa-bbbb-cccc",
			package: "hono",
			severity: "moderate",
			title: "A path is forwarded past its middleware",
			range: "<4.13.16",
		},
		{
			id: "GHSA-dddd-eeee-ffff",
			package: "undici",
			severity: "high",
			title: "Unbounded memory in a client",
			range: "<6.24.0",
		},
		{
			id: "GHSA-gggg-hhhh-iiii",
			package: "undici",
			severity: "critical",
			title: "A certificate check is skipped",
			range: ">=4.0.0 <6.29.1",
		},
	]);
	expect(readAudit("{}")).toEqual([]);
	for (const not of [
		"",
		"error: the registry did not answer",
		"[]",
		'{"hono": "high"}',
		'{"hono": [{"severity": "high"}]}',
	])
		expect(readAudit(not), not).toBeNull();
});

test("a high or critical advisory fails unless it is accepted for that package; a lower one is only printed", () => {
	const found = readAudit(AUDIT) as Advisory[];
	const ids = (list: readonly { id: string }[]) => list.map((a) => a.id);

	const none = judge(found, []);
	expect(ids(none.blocking)).toEqual([
		"GHSA-dddd-eeee-ffff",
		"GHSA-gggg-hhhh-iiii",
	]);
	expect(ids(none.below)).toEqual(["GHSA-aaaa-bbbb-cccc"]);

	const one = judge(found, [entry("GHSA-dddd-eeee-ffff", "undici")]);
	expect(ids(one.blocking)).toEqual(["GHSA-gggg-hhhh-iiii"]);
	expect(ids(one.accepted)).toEqual(["GHSA-dddd-eeee-ffff"]);
	expect(one.stale).toEqual([]);

	// Accepted for another package is not accepted for this one.
	expect(
		ids(judge(found, [entry("GHSA-dddd-eeee-ffff", "hono")]).blocking),
	).toEqual(["GHSA-dddd-eeee-ffff", "GHSA-gggg-hhhh-iiii"]);
});

test("an accepted entry the audit no longer reports is stale, and says so", () => {
	const found = readAudit(AUDIT) as Advisory[];
	const gone = entry("GHSA-zzzz-zzzz-zzzz", "undici");
	const verdict = judge(found, [
		entry("GHSA-dddd-eeee-ffff", "undici"),
		entry("GHSA-gggg-hhhh-iiii", "undici"),
		gone,
	]);
	expect(verdict.blocking).toEqual([]);
	expect(verdict.stale).toEqual([gone]);
});

test("every accepted entry names an advisory once, a lockfile that is audited, and a reason", () => {
	const entries = accepted as Accepted[];
	const keys = entries.map((e) => `${e.lockfile} ${e.package} ${e.id}`);
	expect(new Set(keys).size).toBe(keys.length);
	for (const e of entries) {
		expect(e.id, e.id).toMatch(/^GHSA(-[0-9a-z]{4}){3}$/);
		expect(LOCKFILES as readonly string[], e.id).toContain(e.lockfile);
		expect(e.reason.length, e.id).toBeGreaterThan(60);
	}
	for (const lockfile of LOCKFILES)
		expect(
			existsSync(join(import.meta.dir, "..", lockfile, "bun.lock")),
			lockfile,
		).toBe(true);
});
