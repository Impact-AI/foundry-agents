/**
 * The image switches off the analytics client its framework turns on by
 * default, on the stage that runs: left on, the runtime reports anonymous
 * telemetry from the first turn. The backend's dependencies carry no such
 * client.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the frontend image runs with COPILOTKIT_TELEMETRY_DISABLED set", () => {
	const dockerfile = readFileSync(join(import.meta.dir, "Dockerfile"), "utf8");
	const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
	expect(runtime).toMatch(/^ENV COPILOTKIT_TELEMETRY_DISABLED=1$/m);
});
