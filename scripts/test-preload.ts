/**
 * Test preload: give Next.js the `AsyncLocalStorage` its server bootstrap installs.
 *
 * A Next server starts by importing `next/dist/server/node-environment.js`, whose
 * first line installs `globalThis.AsyncLocalStorage` from `async_hooks`. `bun test`
 * never runs that bootstrap, and Bun does not expose `AsyncLocalStorage` as a global
 * on its own. Two things then go wrong, in order, in the one process Bun shares
 * across every test file:
 *
 *  1. `next/dist/server/app-render/async-local-storage.js` reads the global once,
 *     into a module-level constant, and hands out a `FakeAsyncLocalStorage` whose
 *     `run`/`exit`/`enterWith`/`disable` all throw when it is missing. Importing
 *     `NextResponse` from `next/server` is enough to evaluate it.
 *  2. `next/dist/server/node-environment-extensions/console-exit.js` replaces every
 *     `console` method with a wrapper that calls `workUnitAsyncStorage.exit(...)`:
 *     against a fake storage, every `console.error` in the process throws
 *     `Invariant: AsyncLocalStorage accessed in runtime where it is not available`.
 *
 * Installing the global before any test file is imported makes Next build real
 * storages, exactly as it does when it boots a server. See `test-preload.test.ts`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Switch off CopilotKit's anonymous telemetry for the whole run, as the frontend's
 * image and the end-to-end config do: the runtime builds its telemetry client when
 * its module is evaluated and reads the variable then, so it is set here, before any
 * test file imports `@copilotkit/runtime`. A value already in the environment stands.
 */
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "1";

const globals = globalThis as { AsyncLocalStorage?: unknown };

if (typeof globals.AsyncLocalStorage !== "function") {
	globals.AsyncLocalStorage = AsyncLocalStorage;
}

/**
 * `@modelcontextprotocol/sdk`'s CommonJS SSE transport (reached from
 * `@copilotkit/runtime`) opens with `require("eventsource")`. Under Bun the
 * package's `"bun"` export condition hands `require()` the ES-module build, which
 * is only requirable once it has finished evaluating; importing it here guarantees
 * it has by the time any test file loads.
 */
await import("eventsource");
