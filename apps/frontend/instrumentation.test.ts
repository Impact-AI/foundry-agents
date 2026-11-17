/**
 * `NEXT_RUNTIME` exists only where the bundler writes it into the build: the
 * running server's `process.env` does not hold it. Read through a helper
 * (`envString`, `process.env[name]`), the comparison is false in every
 * deployed replica, and `register()` silently skips the Node-only half — the
 * frontend sent no telemetry and never checked identity's deployment rules
 * while it did. Only the literal member read is replaced at build time.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dir, "instrumentation.ts"),
	"utf8",
);
const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

test("register() gates its Node-only half on the literal process.env.NEXT_RUNTIME", () => {
	expect(code).toMatch(/if \(process\.env\.NEXT_RUNTIME === "nodejs"\) \{/);
	const gate = code.indexOf("process.env.NEXT_RUNTIME");
	expect(code.indexOf("startNextTelemetry")).toBeGreaterThan(gate);
	expect(code.indexOf("identityDeploymentRules")).toBeGreaterThan(gate);
});

test("nothing reads NEXT_RUNTIME through a runtime lookup", () => {
	expect(code).not.toMatch(/env(?:String|Int|Flag)\(\s*["']NEXT_RUNTIME["']/);
	expect(code).not.toMatch(/process\.env\[\s*["']NEXT_RUNTIME["']\s*\]/);
});
