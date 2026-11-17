import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The deployment check (`scripts/verify-deployment.ts`) run against this
 * suite's servers, with `azd` stood in for so its environment names them:
 * every frontend, voice and erase check it makes against Azure is held to the
 * app it checks. The checks of Azure itself are held to a stand-in `az` in
 * `scripts/verify-deployment.test.ts`.
 */
const ROOT = join(__dirname, "..", "..", "..");

test("the deployment check passes against the built app, and leaves nothing behind", ({
	baseURL,
}) => {
	test.setTimeout(240_000);
	const work = mkdtempSync(join(tmpdir(), "verify-"));
	writeFileSync(
		join(work, "azd"),
		`#!/bin/sh\n[ "$1 $2" = "env get-values" ] && printf '%s\\n' 'AZURE_ENV_NAME="e2e"' 'FRONTEND_URL="${baseURL}"' 'AUTH_MODE="local"' 'SEED_SAMPLE_LIBRARY="true"'\n`,
	);
	chmodSync(join(work, "azd"), 0o755);
	const report = join(work, "report");
	const run = spawnSync(
		"bun",
		[
			join(ROOT, "scripts", "verify-deployment.ts"),
			"--only",
			"web,voice,destructive",
			"--voice",
			"--destructive",
			"--allow-http",
			"--report",
			report,
		],
		{
			cwd: ROOT,
			env: { ...process.env, PATH: `${work}:${process.env.PATH}` },
			encoding: "utf8",
			timeout: 220_000,
		},
	);
	const outcomes = (
		JSON.parse(readFileSync(`${report}.json`, "utf8")) as {
			outcomes: { name: string; status: string; detail: string }[];
		}
	).outcomes;
	expect(
		outcomes.filter((o) => o.status === "fail"),
		run.stdout,
	).toEqual([]);
	expect(run.status).toBe(0);
	// Every check the three groups hold, in order: one renamed or dropped fails here.
	expect(outcomes.map((o) => [o.name, o.status])).toEqual([
		["the frontend answers /health", "pass"],
		["pages carry a nonce policy and the security headers", "pass"],
		["a public file sets no cookie", "pass"],
		["the API refuses a caller with no session", "pass"],
		["the backend is not reachable from outside", "skipped"],
		["sign-in goes to Entra with a real client id", "skipped"],
		["sign-in holds a session", "pass"],
		["signed-in pages carry the same policy", "pass"],
		["an unknown API path answers as an API does", "pass"],
		["a write from another origin is refused", "pass"],
		["a typed turn streams an answer", "pass"],
		["a conversation is listed, renamed, read and deleted", "pass"],
		["the library lists its documents", "pass"],
		["a picture is served and revalidated", "pass"],
		["the export downloads", "pass"],
		["live voice is offered", "pass"],
		["a live session opens, is sent silence and ends cleanly", "pass"],
		["an erase ends every session of the account", "pass"],
		["a sign-in after an erase reaches nothing of the erased account", "pass"],
		["ingest through --open-listener leaves the account closed", "skipped"],
		["what the run made is taken back", "pass"],
	]);
	expect(
		outcomes.filter((o) => o.status === "skipped").map((o) => o.detail),
	).toEqual([
		"a local run: the backend is on this machine",
		"AUTH_MODE is local: no identity provider to go to",
		"not private: the storage account is public by design",
	]);
});
