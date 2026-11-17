/**
 * Each app's environment is exactly what its `.env.example` lists, read from
 * the file: a variable the app reads that the template does not set is a
 * default nobody chose, and a variable the template sets that the app does
 * not read is a lie about configuration. A development-only section, if an
 * example carries one, is excluded, because a deployed replica refuses to
 * start with it. Every secret is a Key Vault reference, never a value. And
 * the app's own source is read for the variables it names, so a read that
 * reaches neither the example nor, through it, the template cannot land.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { allResources, compiledMain, INFRA, sampleDeployment } from "./arm";

/**
 * Variables the template sets beyond the example's own lines: the SDK's
 * identity pick and Auth.js's own origin, which the template, not a person,
 * decides.
 */
const LIBRARY: Record<string, string[]> = {
	backend: ["AZURE_CLIENT_ID"],
	frontend: ["AUTH_URL"],
};

/** Variables a framework sets on its own process, which a source may read without listing. */
const FRAMEWORK_READS = new Set(["NODE_ENV", "NEXT_RUNTIME"]);
/**
 * Set by the frontend's own server for the routes it hosts, never by a
 * template: the key its live voice relay asks the caller route with, minted
 * at start (`apps/frontend/server/main.ts`).
 */
const PROCESS_SET = new Set(["VOICE_RELAY_KEY"]);
/** Set by the frontend's image, never by the template: where its server listens (`apps/frontend/Dockerfile`). */
const IMAGE_SET = new Set(["PORT", "HOSTNAME"]);
/**
 * Read with the runtime's own default and set by nobody: an operator's
 * override, documented under "Read outside a deployment" in
 * docs/configuration.md and commented out in the example.
 */
const OPERATOR_ONLY = new Set(["KEEP_ALIVE_TIMEOUT"]);

/** Where each app's own reads live: its sources, never its tests or its stand-ins. */
const SOURCES: Record<string, string[]> = {
	backend: ["apps/backend/src"],
	frontend: [
		"apps/frontend/src",
		"apps/frontend/app",
		"apps/frontend/server",
		"apps/frontend",
	],
};

/** The repository root: the nearest directory above this one that holds the apps. */
function repositoryRoot(): string {
	let dir = INFRA;
	for (let i = 0; i < 6; i++) {
		if (existsSync(join(dir, "apps", "backend", ".env.example"))) return dir;
		dir = dirname(dir);
	}
	throw new Error(`no repository root above ${INFRA}`);
}

/** `apps/<name>/.env.example`, wherever the repository root is from here. */
function envExample(app: string): string {
	return readFileSync(
		join(repositoryRoot(), "apps", app, ".env.example"),
		"utf8",
	);
}

const SKIP = new Set(["node_modules", ".next", "testing"]);

/** The TypeScript sources under `dir`; the top level of a directory is read without descending when `shallow`. */
function sourceFiles(dir: string, shallow: boolean, out: string[] = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!shallow) sourceFiles(path, false, out);
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
			out.push(path);
		}
	}
	return out;
}

const READ_PATTERNS = [
	/\b(?:envString|envInt|envFlag|envChoice)\(\s*"([A-Z][A-Z0-9_]*)"/g,
	/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
	/\bprocess\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g,
];

/** Every variable an app's source names in a read, with where. */
export function sourceReads(app: string): Map<string, string[]> {
	const root = repositoryRoot();
	const reads = new Map<string, string[]>();
	for (const tree of SOURCES[app] ?? []) {
		const dir = join(root, tree);
		// The frontend's root holds its Auth.js and Next entry files beside the app's folders.
		for (const file of sourceFiles(dir, tree === "apps/frontend")) {
			const text = readFileSync(file, "utf8");
			for (const pattern of READ_PATTERNS) {
				for (const match of text.matchAll(pattern)) {
					const name = match[1] as string;
					const at = reads.get(name) ?? [];
					at.push(relative(root, file));
					reads.set(name, at);
				}
			}
		}
	}
	return reads;
}

export function declaredVariables(example: string): string[] {
	const out: string[] = [];
	let developmentOnly = false;
	for (const line of example.split("\n")) {
		if (/^#.*development only/i.test(line)) developmentOnly = true;
		const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
		if (m && !developmentOnly) out.push(m[1]);
	}
	return out;
}

type Env = { name: string; value?: string; secretRef?: string };
type App = {
	configuration: {
		secrets: { name: string; keyVaultUrl?: string; identity?: string }[];
	};
	template: { containers: { env: Env[] }[] };
};

function app(service: string): App {
	const d = sampleDeployment();
	if (!d) throw new Error("no template");
	const found = allResources(d).find(
		(r) =>
			r.type === "Microsoft.App/containerApps" &&
			r.condition &&
			(r.tags as Record<string, string>)["azd-service-name"] === service,
	);
	if (!found) throw new Error(`no ${service} app`);
	return found.properties as App;
}

const it = test.skipIf(compiledMain() === null);

for (const service of ["backend", "frontend"]) {
	it(`${service}: the env is exactly .env.example`, () => {
		const expected = [
			...new Set([
				...declaredVariables(envExample(service)),
				...LIBRARY[service],
			]),
		].sort();
		const actual = app(service)
			.template.containers[0].env.map((e) => e.name)
			.sort();
		expect(actual).toEqual(expected);
	});

	it(`${service}: every secret is a Key Vault reference`, () => {
		const { configuration, template } = app(service);
		const env = template.containers[0].env;
		for (const e of env.filter((e) => /SECRET/.test(e.name))) {
			expect(e.value, e.name).toBeUndefined();
			expect(e.secretRef, e.name).toBeString();
		}
		for (const e of env.filter((e) => e.secretRef)) {
			const secret = configuration.secrets.find((s) => s.name === e.secretRef);
			expect(secret, `${e.name} -> ${e.secretRef}`).toBeDefined();
			expect(secret?.keyVaultUrl, e.name).toContain(`secrets/${e.secretRef}`);
			expect(secret?.identity, e.name).toBeTruthy();
		}
	});
}

it("the migrate job runs with the backend's environment, differing only in its identity and what it sets up", () => {
	const d = sampleDeployment();
	if (!d) return;
	const job = allResources(d).find(
		(r) => r.type === "Microsoft.App/jobs" && r.condition,
	);
	if (!job) throw new Error("no migrate job");
	// A value only a deployment can answer prints as its path, so two
	// references to the same output read equal.
	const byName = (env: Env[]) =>
		Object.fromEntries(
			env.map((e) => [e.name, String(e.value ?? `@${e.secretRef}`)]),
		);
	const jobEnv = byName((job.properties as App).template.containers[0].env);
	const backendEnv = byName(app("backend").template.containers[0].env);
	const differing = Object.keys(backendEnv).filter(
		(name) => jobEnv[name] !== backendEnv[name],
	);
	expect(Object.keys(jobEnv).sort()).toEqual(Object.keys(backendEnv).sort());
	// Its own identity, the storage account its search pipeline's data
	// source names, which the backend carries empty, and no cache.
	expect(differing.sort()).toEqual(
		["AZURE_CLIENT_ID", "AZURE_STORAGE_RESOURCE_ID", "REDIS_URL"].sort(),
	);
	expect(jobEnv.REDIS_URL).toBe("");
	expect(backendEnv.AZURE_STORAGE_RESOURCE_ID).toBe("");
	expect(jobEnv.AZURE_STORAGE_RESOURCE_ID).toContain("outputs.resourceId");
});

it("the backend is told the Foundry project and its guardrail by the modules that make them", () => {
	const env = Object.fromEntries(
		app("backend").template.containers[0].env.map((e) => [
			e.name,
			String(e.value),
		]),
	);
	expect(env.FOUNDRY_PROJECT_ENDPOINT).toContain("outputs.endpoint");
	expect(env.FOUNDRY_RAI_POLICY).toContain("outputs.guardrail");
});

it("the backend is live while its process runs and ready once its host has started", () => {
	type Probe = { type: string; httpGet: { path: string } };
	// The placeholder a first provision runs has no probes; a deployed image does.
	const deployed = sampleDeployment({ backendImage: "registry/backend:1" });
	if (!deployed) return;
	const backend = allResources(deployed).find(
		(r) =>
			r.type === "Microsoft.App/containerApps" &&
			(r.tags as Record<string, string>)["azd-service-name"] === "backend",
	)?.properties as { template: { containers: { probes: Probe[] }[] } };
	const probes = backend.template.containers[0]?.probes ?? [];
	expect(
		Object.fromEntries(probes.map((p) => [p.type, p.httpGet.path])),
	).toEqual({ Liveness: "/health", Readiness: "/ready" });
});

it("the backend's grace covers a drain: the voice document's grace and settle, with room", () => {
	const deployment = sampleDeployment();
	if (!deployment) return;
	const backend = allResources(deployment).find(
		(r) =>
			r.type === "Microsoft.App/containerApps" &&
			(r.tags as Record<string, string>)["azd-service-name"] === "backend",
	)?.properties as { template: { terminationGracePeriodSeconds: number } };
	// live.drainGraceMs 10000 + live.settleWaitMs 5000 (@platform/voice's defaults).
	expect(backend.template.terminationGracePeriodSeconds).toBeGreaterThan(15);
});

for (const service of ["backend", "frontend"]) {
	test(`${service}: every variable its source reads is in its .env.example, so the template sets it too`, () => {
		const declared = new Set([
			...declaredVariables(envExample(service)),
			...LIBRARY[service],
			...FRAMEWORK_READS,
			...PROCESS_SET,
			...(service === "frontend" ? [...IMAGE_SET, ...OPERATOR_ONLY] : []),
		]);
		const reads = sourceReads(service);
		expect(reads.size).toBeGreaterThan(0);
		const unlisted = [...reads]
			.filter(([name]) => !declared.has(name))
			.map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
		expect(unlisted).toEqual([]);
	});
}

test("the source reader finds the three ways a variable is read, and skips tests and stand-ins", () => {
	const reads = sourceReads("backend");
	expect(reads.get("PORT")).toEqual(["apps/backend/src/index.ts"]);
	expect(reads.has("TMPDIR")).toBe(false);
	expect(sourceReads("frontend").get("BACKEND_URL")).toContain(
		"apps/frontend/src/backend/client.ts",
	);
	// The frontend's own server is its source too.
	expect(sourceReads("frontend").get("KEEP_ALIVE_TIMEOUT")).toEqual([
		"apps/frontend/server/main.ts",
	]);
});

test("the parser reads the development-only section as excluded", () => {
	expect(declaredVariables("A=1\n# --- development only ---\nB=\n")).toEqual([
		"A",
	]);
	expect(declaredVariables("A=1\n# B=2\nC=\n")).toEqual(["A", "C"]);
});
