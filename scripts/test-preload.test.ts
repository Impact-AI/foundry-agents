import { expect, test } from "bun:test";

/**
 * The guard on `scripts/test-preload.ts`, which is load-bearing for the whole suite.
 *
 * Without it, importing `next/server` anywhere makes Next capture a *fake*
 * AsyncLocalStorage for the life of the process, and Next's console patch then turns
 * every `console.error` into `Invariant: AsyncLocalStorage accessed in runtime where it
 * is not available` — and only when the suite runs together, because Bun shares one
 * process across every file.
 *
 * The preload is easy to lose: it is one line of TOML, and deleting it breaks tests that
 * name nothing to do with it. So this asserts three things — that the wiring is present,
 * that it took effect in this process, and that the storage Next actually reaches for is
 * a real one.
 */

const PRELOAD = "./scripts/test-preload.ts";

test("bunfig.toml preloads the AsyncLocalStorage shim for every test file", async () => {
	const bunfig = await Bun.file(
		new URL("../bunfig.toml", import.meta.url),
	).text();
	const preload = bunfig.match(/^preload\s*=\s*(\[.*\])$/m)?.[1];

	expect(preload).toBeDefined();
	expect(JSON.parse(preload as string)).toContain(PRELOAD);
});

test("the preload ran, so the global Next reads is the real one", () => {
	expect(
		typeof (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage,
	).toBe("function");
});

test("the storage Next's console patch exits is a real one, not a throwing fake", async () => {
	// Exactly the call `node-environment-extensions/console-exit.js` wraps every
	// console method in. Against a FakeAsyncLocalStorage it throws instead of running,
	// which is how a `console.error` deep in an unrelated test became a test failure.
	const { workUnitAsyncStorage } = await import(
		"next/dist/server/app-render/work-unit-async-storage.external.js"
	);

	expect(workUnitAsyncStorage.exit(() => "ran")).toBe("ran");
});

test("the preload settled eventsource, so the SDK's CommonJS SSE transport can require() it", async () => {
	// The exact line `@modelcontextprotocol/sdk/dist/cjs/client/sse.js` opens
	// with, reached from `@copilotkit/runtime` through `@ag-ui/mcp-apps-middleware`.
	// Under Bun the package's `"bun"` export condition hands `require()` the
	// ES-module build, which is only requirable once it has finished evaluating;
	// the preload is what guarantees it has by the time any test file loads.
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);

	const { EventSource } = require("eventsource");
	expect(EventSource).toBe((await import("eventsource")).EventSource);

	const {
		SSEClientTransport,
	} = require("@modelcontextprotocol/sdk/client/sse.js");
	expect(typeof SSEClientTransport).toBe("function");
});

test("the preload switched off CopilotKit's telemetry before any test file loaded", () => {
	// The runtime's telemetry client reads this once, when its module is evaluated;
	// set any later, a test that builds the runtime would report from it.
	expect(["1", "true"]).toContain(
		process.env.COPILOTKIT_TELEMETRY_DISABLED as string,
	);
});
