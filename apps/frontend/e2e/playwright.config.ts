import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end suite: this app's production build, served as its image
 * serves it, against the real backend — `dev-fake.ts`, which runs the
 * backend's own app on real Redis, with Foundry Agent Service stood in for
 * at its HTTP boundary and Cosmos DB on the emulator when `COSMOS_ENDPOINT`
 * and `COSMOS_KEY` name one, in memory otherwise. Both are started here,
 * each awaited on its readiness answer, and stopped with SIGTERM, on which
 * the backend drops the database it made.
 *
 * Needs `REDIS_URL` and `bun run e2e:build` first. The ports are
 * `E2E_BACKEND_PORT` and `E2E_FRONTEND_PORT`.
 */

const FRONTEND = join(__dirname, "..");
const ROOT = join(FRONTEND, "..", "..");
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 4198);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 3198);
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
// `localhost`, not 127.0.0.1: Auth.js writes the redirect after a sign-in
// naming the server `localhost`, and the session cookie is the host's.
const ORIGIN = `http://localhost:${FRONTEND_PORT}`;
// Shared by the two servers alone: the frontend signs caller assertions with
// it and the backend's gate verifies them, so every local sign-in is its own
// person and no two tests share an account. The config is read again in each
// worker, which never needs it.
const AUTH_SECRET = randomBytes(32).toString("base64url");

if (!process.env.REDIS_URL)
	throw new Error("REDIS_URL is required: see the header of this file");

export default defineConfig({
	testDir: ".",
	testMatch: /.*\.e2e\.ts$/,
	outputDir: "test-results",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	// A flake is a defect to find, never something to run again.
	retries: 0,
	workers: process.env.CI ? 2 : undefined,
	// A turn the scripted model answers reasons word by word before it acts.
	timeout: 90_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI
		? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
		: "list",
	use: {
		baseURL: ORIGIN,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		locale: "en-GB",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			command: "bun apps/backend/src/testing/dev-fake.ts",
			cwd: ROOT,
			url: `${BACKEND}/ready`,
			env: { PORT: String(BACKEND_PORT), AUTH_SECRET },
			reuseExistingServer: false,
			timeout: 120_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
			stdout: "pipe",
		},
		{
			command: "node .next/standalone/apps/frontend/main.js",
			cwd: FRONTEND,
			url: `${ORIGIN}/health`,
			env: {
				PORT: String(FRONTEND_PORT),
				HOSTNAME: "localhost",
				BACKEND_URL: BACKEND,
				AUTH_SECRET,
				AUTH_MODE: "local",
				AUTH_URL: ORIGIN,
				COPILOTKIT_TELEMETRY_DISABLED: "1",
			},
			reuseExistingServer: false,
			timeout: 60_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
		},
	],
});
