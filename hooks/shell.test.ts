/**
 * How azd starts a hook. azd 1.20 accepts only `sh` and `pwsh` as a hook's
 * shell ("shell type 'bash' is not a valid option"), and on Debian `sh` is
 * dash, which refuses `set -o pipefail`. So azure.yaml says `sh`, and every
 * posix hook hands itself to bash before its first bash-only line.
 */
import { expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AZD = join(import.meta.dir, "..");
const yaml = readFileSync(join(AZD, "azure.yaml"), "utf8");
const posix = [
	...yaml.matchAll(/posix:\n\s+shell: (\S+)\n\s+run: \.\/(hooks\/\S+\.sh)/g),
].map((m) => ({ shell: m[1], script: m[2] as string }));

test("every posix hook is declared with the shell every azd accepts", () => {
	expect(posix.length).toBeGreaterThan(0);
	for (const hook of posix) expect(hook.shell).toBe("sh");
});

test("every hook and script has both twins, and every hook azd runs names both", () => {
	for (const folder of ["hooks", "scripts"]) {
		const bash = readdirSync(join(AZD, folder)).filter((f) =>
			f.endsWith(".sh"),
		);
		expect(bash.length).toBeGreaterThan(0);
		for (const file of bash)
			expect(
				existsSync(join(AZD, folder, file.replace(/\.sh$/, ".ps1"))),
				`${folder}/${file}`,
			).toBe(true);
	}
	const windows = [
		...yaml.matchAll(
			/windows:\n\s+shell: (\S+)\n\s+run: \.\/(hooks\/\S+)\.ps1/g,
		),
	].map((m) => ({ shell: m[1], script: m[2] }));
	expect(windows.map((hook) => `${hook.script}.sh`)).toEqual(
		posix.map((hook) => hook.script),
	);
	for (const hook of windows) expect(hook.shell).toBe("pwsh");
});

test.skipIf(Bun.which("dash") === null)(
	"a hook started by dash runs under bash",
	() => {
		const bin = mkdtempSync(join(tmpdir(), "hook-shell-"));
		writeFileSync(join(bin, "az"), "#!/bin/sh\n");
		chmodSync(join(bin, "az"), 0o755);
		const result = Bun.spawnSync(["dash", join(AZD, "hooks", "predown.sh")], {
			env: {
				PATH: `${bin}:${process.env.PATH}`,
				AZURE_SUBSCRIPTION_ID: "sub",
				AZURE_RESOURCE_GROUP: "rg",
			},
			stderr: "pipe",
		});
		expect(new TextDecoder().decode(result.stderr)).toBe("");
		expect(result.exitCode).toBe(0);
	},
);
