import { test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every hook and script has two twins, `<name>.sh` for bash and `<name>.ps1`
 * for PowerShell, and a test runs its scenario through both: the same
 * stand-ins on PATH, the same calls, words and exit code expected of each.
 * PowerShell needs no Windows: `pwsh` runs the `.ps1` on Linux and macOS as it
 * does there, and finds a stand-in `az` on PATH as bash does.
 *
 *   eachTwin(title, (shell) => …)   one test per twin, a minute each; the
 *                                   PowerShell one skips where `pwsh` is not
 *                                   on PATH
 *   runTwin(shell, script, args, env)   the twin, run as azd runs a hook:
 *                                   `bash <script>.sh` or `pwsh -File <script>.ps1`
 *   startTwin(…)                    the same, not waited for: for a test whose
 *                                   stand-in is a server in this process
 *   spawnTwin(…)                    the same, with the twin's process to send
 *                                   a signal to while it runs
 *
 * PowerShell's `Start-Sleep` is a cmdlet, which nothing on PATH can stand in
 * for as a `sleep` stub does for bash. The run therefore loads a profile that
 * defines it as a function doing nothing, so a wait that is polled or retried
 * costs no time under either twin.
 */
export type Shell = "bash" | "pwsh";
const SHELLS: readonly Shell[] = ["bash", "pwsh"];

const PWSH = Bun.which("pwsh");

export interface TwinRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	/**
	 * Everything the twin said, on either stream, without colour. A warning
	 * is bash's stderr and PowerShell's warning stream, which a host writes
	 * to stdout behind `WARNING: `; what was said is the same.
	 */
	said: string;
}

export function eachTwin(
	title: string,
	body: (shell: Shell) => void | Promise<void>,
	// A scenario is often several runs, and each PowerShell run starts a runtime.
	timeout = 60_000,
): void {
	for (const shell of SHELLS)
		test.skipIf(shell === "pwsh" && PWSH === null)(
			`${title} [${shell}]`,
			() => body(shell),
			timeout,
		);
}

let home: string | undefined;
/** A home of the run's own, whose profile makes `Start-Sleep` cost nothing. */
function pwshHome(): string {
	if (home) return home;
	home = mkdtempSync(join(tmpdir(), "twin-pwsh-"));
	mkdirSync(join(home, "config", "powershell"), { recursive: true });
	writeFileSync(
		join(home, "config", "powershell", "profile.ps1"),
		"function global:Start-Sleep {}\n",
	);
	return home;
}

function command(
	shell: Shell,
	script: string,
	args: readonly string[],
	via: string,
): string[] {
	return shell === "bash"
		? [via, `${script}.sh`, ...args]
		: [
				PWSH ?? "pwsh",
				"-NoLogo",
				"-NonInteractive",
				"-File",
				`${script}.ps1`,
				...args,
			];
}

function environment(
	shell: Shell,
	env: Record<string, string>,
): Record<string, string> {
	if (shell === "bash") return env;
	const own = pwshHome();
	return {
		HOME: own,
		XDG_CONFIG_HOME: join(own, "config"),
		XDG_CACHE_HOME: join(own, "cache"),
		NO_COLOR: "1",
		POWERSHELL_TELEMETRY_OPTOUT: "1",
		POWERSHELL_UPDATECHECK: "Off",
		...env,
	};
}

const plain = (bytes: Uint8Array | ArrayBuffer) =>
	new TextDecoder()
		.decode(bytes)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape that opens a colour sequence
		.replace(/\u001b\[[0-9;]*m/g, "");

function read(exitCode: number, stdout: string, stderr: string): TwinRun {
	return { exitCode, stdout, stderr, said: stdout + stderr };
}

/**
 * Run `<script>.sh` or `<script>.ps1` with `args` and exactly `env` (PATH
 * included: the caller puts its stand-ins first on it). `via` is the program
 * the bash twin is started with — `sh`, where the test is of how azd starts
 * a hook.
 */
export function runTwin(
	shell: Shell,
	script: string,
	args: readonly string[],
	env: Record<string, string>,
	via = "bash",
): TwinRun {
	const result = Bun.spawnSync(command(shell, script, args, via), {
		env: environment(shell, env),
		stdout: "pipe",
		stderr: "pipe",
	});
	return read(result.exitCode, plain(result.stdout), plain(result.stderr));
}

/**
 * As `runTwin`, without blocking this process while the twin runs: `done` is
 * the run once it has ended, and `signal` sends the twin's own process a
 * signal meanwhile, as a closed terminal or a `kill` would.
 */
export function spawnTwin(
	shell: Shell,
	script: string,
	args: readonly string[],
	env: Record<string, string>,
): { done: Promise<TwinRun>; signal(name: NodeJS.Signals): void } {
	const child = Bun.spawn(command(shell, script, args, "bash"), {
		env: environment(shell, env),
		stdout: "pipe",
		stderr: "pipe",
	});
	const done = Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).arrayBuffer(),
		child.exited,
	]).then(([stdout, stderr, exitCode]) =>
		// A twin a signal ended has no exit code of its own; it did not end well.
		read(exitCode ?? 1, plain(stdout), plain(stderr)),
	);
	return { done, signal: (name) => child.kill(name) };
}

/** As `runTwin`, without blocking this process while the twin runs. */
export function startTwin(
	shell: Shell,
	script: string,
	args: readonly string[],
	env: Record<string, string>,
): Promise<TwinRun> {
	return spawnTwin(shell, script, args, env).done;
}
