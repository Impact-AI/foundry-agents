import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The post-deploy smoke test (`scripts/smoke.sh` and its pwsh twin) run
 * against this suite's servers, with `azd` stood in for so its environment
 * names them: the script a person runs against Azure is held to the app it
 * checks. The twin runs where `pwsh` is on PATH, as on GitHub's runners.
 */
const SCRIPTS = join(__dirname, "..", "..", "..", "scripts");
const hasPwsh = spawnSync("pwsh", ["-v"]).status === 0;
const SHELLS = [
	{ name: "bash", command: ["bash", join(SCRIPTS, "smoke.sh")], runs: true },
	{
		name: "pwsh",
		command: ["pwsh", "-NoProfile", "-File", join(SCRIPTS, "smoke.ps1")],
		runs: hasPwsh,
	},
];

function smoke(command: string[], environment: Record<string, string>) {
	const bin = mkdtempSync(join(tmpdir(), "smoke-azd-"));
	const values = Object.entries(environment)
		.map(([key, value]) => `${key}="${value}"`)
		.join("\n");
	writeFileSync(
		join(bin, "azd"),
		`#!/bin/sh\n[ "$1 $2" = "env get-values" ] && printf '%s\\n' '${values}'\n`,
	);
	chmodSync(join(bin, "azd"), 0o755);
	const [program = "", ...args] = command;
	const run = spawnSync(program, args, {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		encoding: "utf8",
		timeout: 120_000,
	});
	return { status: run.status, out: run.stdout, err: run.stderr };
}

for (const shell of SHELLS) {
	test.describe(shell.name, () => {
		test.skip(!shell.runs, "pwsh is not on PATH");

		test("in local mode it signs in, lists the library, streams a turn, and deletes its account", ({
			baseURL,
		}) => {
			const run = smoke(shell.command, {
				FRONTEND_URL: baseURL ?? "",
				AUTH_MODE: "local",
				SEED_SAMPLE_LIBRARY: "true",
			});
			expect(run.err).toBe("");
			expect(run.status).toBe(0);
			expect(run.out.trim().split("\n")).toEqual([
				`smoke: ok   ${baseURL}/health answers`,
				"smoke: ok   the door answers",
				"smoke: ok   an API call without a session is refused (401)",
				"smoke: ok   a local sign-in holds a session",
				"smoke: ok   the library lists the sample's documents",
				"smoke: ok   a chat turn streams an answer",
				"smoke: ok   the smoke test's account is deleted",
			]);
		});

		test("under entra it stops after the unauthenticated checks and says why", ({
			baseURL,
		}) => {
			const run = smoke(shell.command, {
				FRONTEND_URL: baseURL ?? "",
				AUTH_MODE: "entra",
			});
			expect(run.status).toBe(0);
			expect(run.out).toContain(
				"smoke: ok   an API call without a session is refused (401)",
			);
			expect(run.out).toContain(
				"AUTH_MODE is entra, not local: signing in takes a person at the identity provider",
			);
			expect(run.out).not.toContain("sign-in holds a session");
		});
	});
}
