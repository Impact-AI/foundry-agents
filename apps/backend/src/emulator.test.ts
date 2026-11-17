import { expect, test } from "bun:test";
import { join } from "node:path";

/** The laptop's way to the emulator's containers never reaches a deployment's: without the emulator's key it makes nothing. */
test("without the emulator's key, nothing is made and the script says what to set", () => {
	const env = { ...process.env };
	delete env.COSMOS_KEY;
	const run = Bun.spawnSync(["bun", join(import.meta.dir, "emulator.ts")], {
		env: { ...env, COSMOS_ENDPOINT: "https://account.documents.azure.com" },
		stderr: "pipe",
		stdout: "pipe",
	});
	expect(run.exitCode).toBe(1);
	expect(new TextDecoder().decode(run.stderr)).toContain("COSMOS_KEY");
});
