/**
 * The deployment check, without a deployment: its parsing, its report and its
 * runner on their own, and every control-plane check against an `az` stood
 * in for by a program that answers what Azure answers for a healthy
 * environment of each mode, then for one broken thing at a time. The
 * frontend checks run for real against the built stack in
 * `apps/frontend/e2e/verify-deployment.e2e.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHECKS,
	call,
	contextFor,
	directives,
	INSIGHTS_API,
	insightsApp,
	interruptionOf,
	Jar,
	type LiveRun,
	liveProblem,
	markdown,
	modeOf,
	OPERATOR_ROLES,
	type Outcome,
	PRIVATE_ZONES,
	type Probe,
	parseArgs,
	parseEnvValues,
	RESTARTS_MAX,
	realAz,
	refusedFrontend,
	refusedRun,
	runChecks,
	runIngest,
	SECRETS,
	selected,
	usageQuery,
	verdict,
	writeReports,
} from "./verify-deployment";

const API_OF: Record<string, string> = {};
const SUB = "sub-1";
const RG = "rg-check";
const base = `/subscriptions/${SUB}/resourceGroups/${RG}/providers`;
const id = (type: string, name: string) => `${base}/${type}/${name}`;

const work = mkdtempSync(join(tmpdir(), "verify-az-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** An `az` that answers each call from a table, and writes down whether it named the subscription. */
function standInAz(answers: Map<string, unknown>) {
	const dir = mkdtempSync(join(work, "az-"));
	const table = join(dir, "answers.json");
	const calls = join(dir, "calls");
	writeFileSync(table, JSON.stringify(Object.fromEntries(answers)));
	writeFileSync(calls, "");
	const program = join(dir, "az");
	writeFileSync(
		program,
		`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = Bun.argv.slice(2);
const kept = [];
let subscription = "";
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--subscription") subscription = args[++i];
	else if (args[i] === "-o" || args[i] === "--output") i++;
	else if (args[i] !== "--only-show-errors") kept.push(args[i]);
}
const key = kept.join(" ");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ key, subscription }) + "\\n");
const answers = JSON.parse(readFileSync(${JSON.stringify(table)}, "utf8"));
if (!(key in answers)) { console.error("stand-in az: nothing answers " + key); process.exit(1); }
const answer = answers[key];
if (answer && answer.__refuse) { console.error(answer.__refuse); process.exit(1); }
console.log(JSON.stringify(answer));
`,
	);
	chmodSync(program, 0o755);
	return {
		program,
		calls: () =>
			readFileSync(calls, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as { key: string; subscription: string }),
	};
}

const key = (args: string[]) => args.join(" ");

/** A container app as az shows it: its template, its latest revision ready, its own ingress host. */
function appAnswer(
	app: "backend" | "frontend",
	shape: {
		image: string;
		minReplicas: number;
		probes?: unknown[];
		latestReady?: string;
	},
) {
	return {
		properties: {
			latestRevisionName: `ca-${app}-tok--r1`,
			latestReadyRevisionName: shape.latestReady ?? `ca-${app}-tok--r1`,
			configuration: {
				ingress: { fqdn: `ca-${app}-tok.region.azurecontainerapps.io` },
			},
			template: {
				containers: [
					{
						image: shape.image,
						probes: shape.probes ?? [{ type: "Liveness" }],
					},
				],
				scale: { minReplicas: shape.minReplicas },
			},
		},
	};
}

/** A stranger's view: the edge answers, the frontend's own host refuses. */
const healthyProbe: Probe = async (url) =>
	url.startsWith("https://edge.example.net/")
		? new Response("ok", { status: 200 })
		: new Error("connection refused");

type Shape = {
	hardened: boolean;
	jumpHost?: boolean;
	operatorGroup?: boolean;
	/** Entra sign-in on a deployment that is not hardened: its secrets' values are read. */
	entra?: boolean;
};

/** What Azure answers for an environment the template made whole, of the shape given. */
function healthy(shape: Shape) {
	const env: Record<string, string> = {
		AZURE_ENV_NAME: "check",
		AZURE_SUBSCRIPTION_ID: SUB,
		AZURE_RESOURCE_GROUP: RG,
		AZURE_PRINCIPAL_ID: "deployer-oid",
		HARDENED: String(shape.hardened),
		FRONTEND_URL: shape.hardened
			? "https://edge.example.net"
			: "https://frontend.example.net",
		FRONT_DOOR_ENDPOINT: shape.hardened ? "edge.example.net" : "",
		REDIS_PORT: "10000",
		AUTH_MODE: shape.hardened || shape.entra ? "entra" : "local",
	};
	if (shape.jumpHost) env.DEVELOPER_ACCESS = "true";
	if (shape.operatorGroup) {
		env.OPERATOR_PRINCIPAL_ID = "group-oid";
		env.OPERATOR_PRINCIPAL_TYPE = "Group";
	}
	const mode = modeOf(env);
	const operator = env.OPERATOR_PRINCIPAL_ID ?? "deployer-oid";
	const r = (type: string, name: string) => ({
		id: id(type, name),
		name,
		type,
	});
	const services = {
		redis: r("Microsoft.Cache/redisEnterprise", "redis-tok"),
		vault: r("Microsoft.KeyVault/vaults", "kv-tok"),
		settings: r("Microsoft.AppConfiguration/configurationStores", "appcs-tok"),
		search: r("Microsoft.Search/searchServices", "srch-tok"),
		models: r("Microsoft.CognitiveServices/accounts", "cog-tok"),
		storage: r("Microsoft.Storage/storageAccounts", "sttok"),
		cosmos: r("Microsoft.DocumentDB/databaseAccounts", "cosmos-tok"),
	};
	const resources = [
		r("Microsoft.App/containerApps", "ca-backend-tok"),
		r("Microsoft.App/containerApps", "ca-frontend-tok"),
		r("Microsoft.App/jobs", "caj-migrate-tok"),
		r("Microsoft.App/managedEnvironments", "cae-tok"),
		r("Microsoft.ContainerRegistry/registries", "crtok"),
		r("Microsoft.ManagedIdentity/userAssignedIdentities", "id-backend-tok"),
		r("Microsoft.ManagedIdentity/userAssignedIdentities", "id-frontend-tok"),
		r("Microsoft.ManagedIdentity/userAssignedIdentities", "id-migrate-tok"),
		r("Microsoft.OperationalInsights/workspaces", "log-tok"),
		r("Microsoft.Insights/components", "appi-tok"),
		...Object.values(services),
		...(mode.private
			? [
					r("Microsoft.Network/virtualNetworks", "vnet-tok"),
					...Object.keys(services).map((s) =>
						r("Microsoft.Network/privateEndpoints", `pep-${s}`),
					),
					...PRIVATE_ZONES.map((z) =>
						r("Microsoft.Network/privateDnsZones", z),
					),
				]
			: []),
		...(mode.frontDoor
			? [
					r("Microsoft.Cdn/profiles", "afd-tok"),
					r(
						"Microsoft.Network/frontdoorWebApplicationFirewallPolicies",
						"waftok",
					),
				]
			: []),
		...(mode.jumpHost
			? [
					r("Microsoft.Compute/virtualMachines", "vm-jump-tok"),
					r("Microsoft.Network/bastionHosts", "bas-tok"),
				]
			: []),
	];
	const a = new Map<string, unknown>();
	const get = (path: string, version: string, answer: unknown) => {
		API_OF[path] = version;
		a.set(key(call.get(path, version)), answer);
	};
	a.set(key(call.group(RG)), {
		properties: { provisioningState: "Succeeded" },
	});
	a.set(key(call.resources(RG)), resources);
	get(services.redis.id, "2025-07-01", {
		sku: { name: "Balanced_B0" },
		properties: {
			highAvailability: mode.zonal ? "Enabled" : "Disabled",
			publicNetworkAccess: mode.private ? "Disabled" : "Enabled",
			minimumTlsVersion: "1.2",
		},
	});
	get(`${services.redis.id}/databases/default`, "2025-07-01", {
		properties: {
			clusteringPolicy: "NoCluster",
			port: 10000,
			accessKeysAuthentication: "Disabled",
			clientProtocol: "Encrypted",
		},
	});
	const admitted = [
		"backend-oid",
		...(mode.jumpHost && !shape.operatorGroup ? [operator] : []),
	];
	get(
		`${services.redis.id}/databases/default/accessPolicyAssignments`,
		"2025-07-01",
		{
			value: admitted.map((objectId) => ({
				properties: { accessPolicyName: "default", user: { objectId } },
			})),
		},
	);
	get(
		id("Microsoft.ManagedIdentity/userAssignedIdentities", "id-backend-tok"),
		"2023-01-31",
		{
			properties: { principalId: "backend-oid" },
		},
	);
	const floor = mode.zonal ? 2 : 1;
	for (const app of ["backend", "frontend"] as const) {
		get(
			id("Microsoft.App/containerApps", `ca-${app}-tok`),
			"2025-01-01",
			appAnswer(app, {
				image: `crtok.azurecr.io/${app}:abc`,
				minReplicas: floor,
			}),
		);
		const revision = `${id("Microsoft.App/containerApps", `ca-${app}-tok`)}/revisions/ca-${app}-tok--r1`;
		get(revision, "2025-01-01", {
			properties: { healthState: "Healthy", runningState: "Running" },
		});
		get(`${revision}/replicas`, "2025-01-01", {
			value: Array.from({ length: floor }, (_, i) => ({
				name: `ca-${app}-tok--r1-${i}`,
				properties: {
					runningState: "Running",
					containers: [{ ready: true, restartCount: 0 }],
				},
			})),
		});
	}
	get(id("Microsoft.App/jobs", "caj-migrate-tok"), "2025-01-01", {
		properties: {
			template: { containers: [{ image: "crtok.azurecr.io/backend:abc" }] },
		},
	});
	const access = mode.private ? "Disabled" : "Enabled";
	get(services.search.id, "2024-06-01-preview", {
		properties: {
			replicaCount: floor,
			publicNetworkAccess: access.toLowerCase(),
		},
	});
	get(services.vault.id, "2023-07-01", {
		properties: { publicNetworkAccess: access },
	});
	get(services.settings.id, "2024-05-01", {
		properties: { publicNetworkAccess: access },
	});
	get(services.models.id, "2024-10-01", {
		properties: { publicNetworkAccess: access },
	});
	get(services.cosmos.id, "2024-11-15", {
		properties: { publicNetworkAccess: access },
	});
	get(`${services.vault.id}/secrets`, "2023-07-01", {
		value: SECRETS.map((name) => ({ name })),
	});
	for (const name of SECRETS)
		a.set(key(call.secret("kv-tok", name)), {
			value: name === "auth-secret" ? "s".repeat(64) : `${name}-value`,
		});
	a.set(key(call.cosmosContainer(RG, "cosmos-tok", "accounts")), {
		resource: { defaultTtl: -1 },
	});
	get(services.storage.id, "2023-05-01", {
		tags: { "azd-env-name": "check" },
		properties: mode.private
			? {
					publicNetworkAccess: "Disabled",
					networkAcls: { defaultAction: "Deny", ipRules: [] },
				}
			: {
					publicNetworkAccess: "Enabled",
					networkAcls: { defaultAction: "Allow", ipRules: [] },
				},
	});
	for (const [name, service] of Object.entries(services))
		get(id("Microsoft.Network/privateEndpoints", `pep-${name}`), "2024-05-01", {
			properties: {
				privateLinkServiceConnections: [
					{
						properties: {
							privateLinkServiceId: service.id,
							privateLinkServiceConnectionState: { status: "Approved" },
						},
					},
				],
			},
		});
	for (const target of [
		services.redis.id,
		`${services.redis.id}/databases/default`,
		services.vault.id,
		services.settings.id,
		services.search.id,
		services.models.id,
		services.cosmos.id,
		services.storage.id,
		id("Microsoft.ContainerRegistry/registries", "crtok"),
	])
		a.set(key(call.diagnostics(target)), [
			{
				name: "to-workspace",
				workspaceId: id("Microsoft.OperationalInsights/workspaces", "log-tok"),
			},
		]);
	a.set(key(call.roles(operator)), [
		...OPERATOR_ROLES.map((roleDefinitionName) => ({
			roleDefinitionName,
			roleDefinitionId: "/x/other",
			scope: services.vault.id,
		})),
		{
			roleDefinitionName: "Foundry User",
			roleDefinitionId:
				"/x/roleDefinitions/53ca6127-db72-4b80-b1b0-d745d6d5456d",
			scope: services.models.id,
		},
	]);
	a.set(key(call.cosmosRoles(RG, "cosmos-tok")), [
		{ principalId: "backend-oid" },
		{ principalId: operator },
	]);
	get(
		id("Microsoft.Network/frontdoorWebApplicationFirewallPolicies", "waftok"),
		"2024-02-01",
		{
			properties: {
				policySettings: { enabledState: "Enabled", mode: "Prevention" },
			},
		},
	);
	return { env, answers: a, services };
}

const OPTIONS = parseArgs([]);
const control = CHECKS.filter((c) => c.group === "control");

async function runControl(
	env: Record<string, string>,
	answers: Map<string, unknown>,
	probe: Probe = healthyProbe,
) {
	const az = standInAz(answers);
	const ctx = contextFor(env, OPTIONS, realAz(SUB, az.program));
	ctx.probe = probe;
	const outcomes = await runChecks(control, ctx);
	return { outcomes, calls: az.calls() };
}

const failed = (outcomes: Outcome[]) =>
	outcomes.filter((o) => o.status === "fail").map((o) => o.name);
const byName = (outcomes: Outcome[], name: string) =>
	outcomes.find((o) => o.name.startsWith(name)) as Outcome;

describe("the control checks against a healthy environment", () => {
	test("hardened: every check passes, and every az call names the environment's subscription", async () => {
		const { env, answers } = healthy({ hardened: true });
		const { outcomes, calls } = await runControl(env, answers);
		expect(failed(outcomes)).toEqual([]);
		expect(outcomes.filter((o) => o.status === "skipped")).toEqual([]);
		expect(calls.length).toBeGreaterThan(20);
		expect(calls.every((c) => c.subscription === SUB)).toBe(true);
	});

	test("demo: nothing fails, and what a demo has none of is skipped with its reason", async () => {
		const { env, answers } = healthy({ hardened: false });
		const { outcomes } = await runControl(env, answers);
		expect(failed(outcomes)).toEqual([]);
		expect(
			outcomes.filter((o) => o.status === "skipped").map((o) => o.detail),
		).toEqual([
			"not private: the data services are public by design",
			"not private: the data services have no private endpoints",
			"no Front Door in this mode",
			"no Front Door in this mode",
		]);
		expect(byName(outcomes, "Key Vault").detail).toContain("carry real values");
	});

	test("with the jump host, the operator is admitted to Redis beside the backend", async () => {
		const { env, answers } = healthy({ hardened: true, jumpHost: true });
		const { outcomes } = await runControl(env, answers);
		expect(failed(outcomes)).toEqual([]);
		expect(byName(outcomes, "Redis admits").detail).toBe(
			"2 assignment(s) on the default policy",
		);
	});
});

describe("the control checks find each broken thing", () => {
	const broken: [
		string,
		Shape,
		(h: ReturnType<typeof healthy>) => void,
		string,
	][] = [
		[
			"a placeholder image",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							id("Microsoft.App/containerApps", "ca-frontend-tok"),
							"2025-01-01",
						),
					),
					appAnswer("frontend", {
						image:
							"mcr.microsoft.com/azuredocs/containerapps-helloworld:latest",
						probes: [],
						minReplicas: 2,
					}),
				),
			"both apps run a built image",
		],
		[
			"Redis access keys enabled",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(`${h.services.redis.id}/databases/default`, "2025-07-01"),
					),
					{
						properties: {
							clusteringPolicy: "NoCluster",
							port: 10000,
							accessKeysAuthentication: "Enabled",
							clientProtocol: "Encrypted",
						},
					},
				),
			"Azure Managed Redis database",
		],
		[
			"Redis not replicated on a zonal deployment",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.get(h.services.redis.id, "2025-07-01")), {
					sku: { name: "Balanced_B0" },
					properties: {
						highAvailability: "Disabled",
						publicNetworkAccess: "Disabled",
						minimumTlsVersion: "1.2",
					},
				}),
			"Azure Managed Redis instance",
		],
		[
			"a group operator admitted to Redis",
			{ hardened: true, jumpHost: true, operatorGroup: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							`${h.services.redis.id}/databases/default/accessPolicyAssignments`,
							"2025-07-01",
						),
					),
					{
						value: ["backend-oid", "group-oid"].map((objectId) => ({
							properties: { user: { objectId } },
						})),
					},
				),
			"Redis admits",
		],
		[
			"the session secret left as the placeholder",
			{ hardened: false },
			(h) =>
				h.answers.set(key(call.secret("kv-tok", "auth-secret")), {
					value: "unset",
				}),
			"Key Vault holds",
		],
		[
			"a secret missing from the vault",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(call.get(`${h.services.vault.id}/secrets`, "2023-07-01")),
					{ value: [{ name: "auth-secret" }] },
				),
			"Key Vault holds",
		],
		[
			"an ingest run's tag left on the storage account",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.get(h.services.storage.id, "2023-05-01")), {
					tags: {
						ingestListener: "run-1:203.0.113.7:listener+rule:1700000000",
					},
					properties: {
						publicNetworkAccess: "Disabled",
						networkAcls: { defaultAction: "Deny", ipRules: [] },
					},
				}),
			"the storage account",
		],
		[
			"a storage account left open with a rule",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.get(h.services.storage.id, "2023-05-01")), {
					tags: {},
					properties: {
						publicNetworkAccess: "Disabled",
						networkAcls: {
							defaultAction: "Deny",
							ipRules: [{ value: "203.0.113.7" }],
						},
					},
				}),
			"the storage account",
		],
		[
			"the accounts container without lifetimes",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.cosmosContainer(RG, "cosmos-tok", "accounts")), {
					resource: {},
				}),
			"the accounts container",
		],
		[
			"a data service with no approved endpoint",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							id("Microsoft.Network/privateEndpoints", "pep-cosmos"),
							"2024-05-01",
						),
					),
					{
						properties: {
							privateLinkServiceConnections: [
								{
									properties: {
										privateLinkServiceId: h.services.cosmos.id,
										privateLinkServiceConnectionState: { status: "Pending" },
									},
								},
							],
						},
					},
				),
			"private endpoints",
		],
		[
			"a frontend with one replica on a zonal deployment",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							id("Microsoft.App/containerApps", "ca-frontend-tok"),
							"2025-01-01",
						),
					),
					appAnswer("frontend", {
						image: "crtok.azurecr.io/frontend:abc",
						minReplicas: 1,
					}),
				),
			"replica floors",
		],
		[
			"the Redis database without its diagnostic setting",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(call.diagnostics(`${h.services.redis.id}/databases/default`)),
					[],
				),
			"diagnostic settings",
		],
		[
			"an operator missing a data role",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.roles("deployer-oid")), [
					{
						roleDefinitionName: "Key Vault Secrets Officer",
						roleDefinitionId: "/x",
						scope: h.services.vault.id,
					},
				]),
			"the operator holds",
		],
		[
			"a WAF in detection",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							id(
								"Microsoft.Network/frontdoorWebApplicationFirewallPolicies",
								"waftok",
							),
							"2024-02-01",
						),
					),
					{
						properties: {
							policySettings: { enabledState: "Enabled", mode: "Detection" },
						},
					},
				),
			"the edge's WAF",
		],
		[
			"a backend whose containers keep restarting",
			{ hardened: true },
			(h) => {
				const revision = `${id("Microsoft.App/containerApps", "ca-backend-tok")}/revisions/ca-backend-tok--r1`;
				h.answers.set(key(call.get(`${revision}/replicas`, "2025-01-01")), {
					value: [
						{
							name: "r1-0",
							properties: {
								runningState: "Running",
								containers: [{ ready: true, restartCount: RESTARTS_MAX }],
							},
						},
						{
							name: "r1-1",
							properties: {
								runningState: "Running",
								containers: [{ ready: true, restartCount: 0 }],
							},
						},
					],
				});
			},
			"both apps' latest revision",
		],
		[
			"a backend whose latest revision never became ready",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							id("Microsoft.App/containerApps", "ca-backend-tok"),
							"2025-01-01",
						),
					),
					appAnswer("backend", {
						image: "crtok.azurecr.io/backend:abc",
						minReplicas: 2,
						latestReady: "ca-backend-tok--r0",
					}),
				),
			"both apps' latest revision",
		],
		[
			"a backend revision running no replica",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							`${id("Microsoft.App/containerApps", "ca-backend-tok")}/revisions/ca-backend-tok--r1/replicas`,
							"2025-01-01",
						),
					),
					{ value: [] },
				),
			"both apps' latest revision",
		],
		[
			"a session secret shorter than 32 characters",
			{ hardened: false },
			(h) =>
				h.answers.set(key(call.secret("kv-tok", "auth-secret")), {
					value: "s".repeat(31),
				}),
			"Key Vault holds",
		],
		[
			"Redis accepting TLS below 1.2",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.get(h.services.redis.id, "2025-07-01")), {
					sku: { name: "Balanced_B0" },
					properties: {
						highAvailability: "Enabled",
						publicNetworkAccess: "Disabled",
						minimumTlsVersion: "1.0",
					},
				}),
			"Azure Managed Redis instance",
		],
		[
			"Redis at a SKU the template does not make",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.get(h.services.redis.id, "2025-07-01")), {
					sku: { name: "Balanced_B1" },
					properties: {
						highAvailability: "Enabled",
						publicNetworkAccess: "Disabled",
						minimumTlsVersion: "1.2",
					},
				}),
			"Azure Managed Redis instance",
		],
		[
			"REDIS_PORT naming a port the database does not listen on",
			{ hardened: true },
			(h) => {
				h.env.REDIS_PORT = "6380";
			},
			"Azure Managed Redis database",
		],
		[
			"a policy assignment that names no principal",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(
						call.get(
							`${h.services.redis.id}/databases/default/accessPolicyAssignments`,
							"2025-07-01",
						),
					),
					{
						value: [
							{ properties: { user: { objectId: "backend-oid" } } },
							{ properties: { user: {} } },
						],
					},
				),
			"Redis admits",
		],
		[
			"neither the backend's identity nor the policy naming a principal",
			{ hardened: true },
			(h) => {
				h.answers.set(
					key(
						call.get(
							id(
								"Microsoft.ManagedIdentity/userAssignedIdentities",
								"id-backend-tok",
							),
							"2023-01-31",
						),
					),
					{ properties: {} },
				);
				h.answers.set(
					key(
						call.get(
							`${h.services.redis.id}/databases/default/accessPolicyAssignments`,
							"2025-07-01",
						),
					),
					{ value: [{ properties: { user: {} } }] },
				);
			},
			"Redis admits",
		],
		[
			"AI Search with one replica on a zonal deployment",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(call.get(h.services.search.id, "2024-06-01-preview")),
					{ properties: { replicaCount: 1, publicNetworkAccess: "disabled" } },
				),
			"replica floors",
		],
		[
			"a diagnostic setting sending to another environment's workspace",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.diagnostics(h.services.vault.id)), [
					{
						name: "elsewhere",
						workspaceId: `/subscriptions/${SUB}/resourceGroups/rg-other/providers/Microsoft.OperationalInsights/workspaces/log-other`,
					},
				]),
			"diagnostic settings",
		],
		[
			"the operator's roles held on a group whose name only begins as this one's",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(call.roles("deployer-oid")),
					(
						h.answers.get(key(call.roles("deployer-oid"))) as {
							scope: string;
						}[]
					).map((a) => ({
						...a,
						scope: a.scope.replace(
							`/resourceGroups/${RG}/`,
							`/resourceGroups/${RG}-old/`,
						),
					})),
				),
			"the operator holds",
		],
		[
			"a missing resource",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(call.resources(RG)),
					(h.answers.get(key(call.resources(RG))) as { type: string }[]).filter(
						(r) => r.type !== "Microsoft.Cdn/profiles",
					),
				),
			"every resource",
		],
		...(
			[
				["Key Vault", "vault", "2023-07-01", "Enabled"],
				["App Configuration", "settings", "2024-05-01", "Enabled"],
				["AI Search", "search", "2024-06-01-preview", "enabled"],
				["the Foundry account", "models", "2024-10-01", "Enabled"],
				["Cosmos DB", "cosmos", "2024-11-15", "Enabled"],
			] as const
		).map(
			([label, service, version, open]) =>
				[
					`${label} open to the public network on a private deployment`,
					{ hardened: true },
					(h: ReturnType<typeof healthy>) => {
						const at = key(call.get(h.services[service].id, version));
						const held = h.answers.get(at) as { properties: object };
						h.answers.set(at, {
							...held,
							properties: { ...held.properties, publicNetworkAccess: open },
						});
					},
					"no data service answers the public network",
				] as const,
		),
		[
			"a data service whose answer does not say it is closed",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.get(h.services.vault.id, "2023-07-01")), {
					properties: {},
				}),
			"no data service answers the public network",
		],
		[
			"the operator without Foundry User",
			{ hardened: true },
			(h) =>
				h.answers.set(
					key(call.roles("deployer-oid")),
					(
						h.answers.get(key(call.roles("deployer-oid"))) as {
							roleDefinitionId: string;
						}[]
					).filter((a) => !a.roleDefinitionId.endsWith("d5456d")),
				),
			"the operator holds",
		],
		[
			"the operator without a Cosmos DB data role",
			{ hardened: true },
			(h) =>
				h.answers.set(key(call.cosmosRoles(RG, "cosmos-tok")), [
					{ principalId: "backend-oid" },
				]),
			"the operator holds",
		],
		[
			"the Entra client secret left as the placeholder",
			{ hardened: false, entra: true },
			(h) =>
				h.answers.set(key(call.secret("kv-tok", "entra-client-secret")), {
					value: "unset",
				}),
			"Key Vault holds",
		],
		[
			"the Entra client id left as the placeholder",
			{ hardened: false, entra: true },
			(h) =>
				h.answers.set(key(call.secret("kv-tok", "entra-client-id")), {
					value: "unset",
				}),
			"Key Vault holds",
		],
		[
			"the frontend running an older image than azd deployed",
			{ hardened: true },
			(h) => {
				h.env.SERVICE_FRONTEND_IMAGE_NAME = "crtok.azurecr.io/frontend:new";
			},
			"both apps run a built image",
		],
		[
			"the migrate job running another image than the backend's",
			{ hardened: true },
			(h) => {
				h.env.SERVICE_BACKEND_IMAGE_NAME = "crtok.azurecr.io/backend:abc";
				h.answers.set(
					key(
						call.get(id("Microsoft.App/jobs", "caj-migrate-tok"), "2025-01-01"),
					),
					{
						properties: {
							template: {
								containers: [{ image: "crtok.azurecr.io/backend:old" }],
							},
						},
					},
				);
			},
			"both apps run a built image",
		],
	];
	for (const [what, shape, breakIt, check] of broken)
		test(`${what} fails "${check}…" and nothing else`, async () => {
			const h = healthy(shape);
			breakIt(h);
			const { outcomes } = await runControl(h.env, h.answers);
			const names = failed(outcomes);
			expect(names.length).toBe(1);
			expect(names[0]?.startsWith(check)).toBe(true);
		});

	// One control run each: a hardened run asks the stand-in `az` for every
	// resource, and two in one test sit at the default time limit under the
	// whole suite's load.
	for (const [what, probe] of [
		[
			"an edge that does not answer",
			(async () => new Error("timed out")) as Probe,
		],
		[
			"a frontend that answers around the edge",
			(async () => new Response("ok", { status: 200 })) as Probe,
		],
	] as const)
		test(`${what} fails the edge check and nothing else`, async () => {
			const h = healthy({ hardened: true });
			const { outcomes } = await runControl(h.env, h.answers, probe);
			expect(failed(outcomes)).toEqual([
				"the frontend is reached through the edge and only there",
			]);
		});

	test("an az that refuses fails its check with what it said, and the others still run", async () => {
		const h = healthy({ hardened: true });
		h.answers.set(key(call.cosmosContainer(RG, "cosmos-tok", "accounts")), {
			__refuse: "(AuthorizationFailed) no read on the account",
		});
		const { outcomes } = await runControl(h.env, h.answers);
		const outcome = byName(outcomes, "the accounts container");
		expect(outcome.status).toBe("fail");
		expect(outcome.evidence).toContain("AuthorizationFailed");
		expect(failed(outcomes)).toEqual([outcome.name]);
	});

	test("an environment with no resource group names what to do", async () => {
		const h = healthy({ hardened: true });
		delete h.env.AZURE_RESOURCE_GROUP;
		const { outcomes } = await runControl(h.env, h.answers);
		expect(byName(outcomes, "resource group exists").detail).toContain(
			"run azd up",
		);
	});
});

describe("the run", () => {
	test("arguments: groups are named, unknown ones and flags refused", () => {
		expect(
			parseArgs(["--only", "web,voice", "--voice", "--report", "out"]),
		).toMatchObject({ only: ["web", "voice"], voice: true, report: "out" });
		expect(() => parseArgs(["--only", "webb"])).toThrow(
			'names no group "webb"',
		);
		expect(() => parseArgs(["--env"])).toThrow("needs a value");
		expect(() => parseArgs(["--deploy"])).toThrow("unknown argument");
		expect(() => parseArgs(["--only", "voice"])).toThrow(
			"--only voice selects nothing without --voice",
		);
		expect(() => parseArgs(["--only", "web,destructive"])).toThrow(
			"--only destructive selects nothing without --destructive",
		);
	});

	test("a frontend is checked over https, or over http only on this machine and only when asked", () => {
		expect(
			refusedFrontend("https://edge.example.net", parseArgs([])),
		).toBeNull();
		expect(
			refusedFrontend("http://localhost:3000", parseArgs(["--allow-http"])),
		).toBeNull();
		expect(
			refusedFrontend("https://edge.example.net", parseArgs(["--allow-http"])),
		).toContain("--allow-http is for a frontend on this machine");
		expect(
			refusedFrontend("http://edge.example.net", parseArgs(["--allow-http"])),
		).toContain("--allow-http is for a frontend on this machine");
		expect(refusedFrontend("http://localhost:3000", parseArgs([]))).toContain(
			"add --allow-http",
		);
	});

	test("voice and destructive checks run only when asked for", () => {
		const groups = (argv: string[]) => [
			...new Set(selected(parseArgs(argv)).map((c) => c.group)),
		];
		expect(groups([])).toEqual(["control", "web", "telemetry"]);
		expect(groups(["--voice", "--destructive"])).toEqual([
			"control",
			"web",
			"voice",
			"telemetry",
			"destructive",
		]);
		expect(groups(["--only", "web,voice", "--voice"])).toEqual([
			"web",
			"voice",
		]);
	});

	test("the azd environment is read as azd prints it", () => {
		expect(parseEnvValues('A="1"\nB="with \\"quotes\\""\n\nC=bare\n')).toEqual({
			A: "1",
			B: 'with "quotes"',
			C: "bare",
		});
	});

	test("the mode resolves the overrides as the template does", () => {
		expect(modeOf({ HARDENED: "true" })).toEqual({
			hardened: true,
			private: true,
			zonal: true,
			frontDoor: true,
			jumpHost: false,
			authMode: "entra",
		});
		expect(
			modeOf({
				HARDENED: "true",
				ZONE_REDUNDANT: "false",
				DEVELOPER_ACCESS: "true",
			}),
		).toMatchObject({ zonal: false, jumpHost: true });
		expect(
			modeOf({ PRIVATE_NETWORKING: "true", AUTH_MODE: "local" }),
		).toMatchObject({ private: true, frontDoor: false, authMode: "local" });
		expect(modeOf({})).toEqual({
			hardened: false,
			private: false,
			zonal: false,
			frontDoor: false,
			jumpHost: false,
			authMode: "local",
		});
	});

	test("a policy header is read by directive, and the insights application by its id", () => {
		expect(
			directives(
				"default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'",
			).get("script-src"),
		).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
		expect(
			insightsApp(
				"InstrumentationKey=k;IngestionEndpoint=https://x/;ApplicationId=1234abcd-0000-0000-0000-00000000abcd",
			),
		).toBe("1234abcd-0000-0000-0000-00000000abcd");
		expect(insightsApp(undefined)).toBeUndefined();
	});

	test("the jar keeps what a response sets and drops what it clears", () => {
		const jar = new Jar();
		const headers = new Headers();
		headers.append("set-cookie", "a=1; Path=/; HttpOnly");
		headers.append("set-cookie", "b=2; Path=/");
		jar.take(new Response(null, { headers }));
		const cleared = new Headers();
		cleared.append("set-cookie", "a=; Path=/; Max-Age=0");
		jar.take(new Response(null, { headers: cleared }));
		expect(jar.header()).toBe("b=2");
		expect(jar.copy().header()).toBe("b=2");
	});

	test("a check that throws is a failure with its evidence, a check with no session it needs fails, and the rest still run", async () => {
		class Boom extends Error {}
		const ctx = contextFor({}, OPTIONS, async () => null);
		const outcomes = await runChecks(
			[
				{
					group: "web",
					name: "throws",
					run: async () => {
						throw new Boom("unexpected");
					},
				},
				{
					group: "web",
					name: "needs a session",
					run: async () =>
						(
							CHECKS.find(
								(c) => c.name === "a write from another origin is refused",
							) as { run: (typeof control)[0]["run"] }
						).run(ctx),
				},
				{
					group: "web",
					name: "passes",
					run: async () => ({ status: "pass", detail: "fine" }),
				},
			],
			ctx,
		);
		expect(outcomes.map((o) => [o.name, o.status])).toEqual([
			["throws", "fail"],
			["needs a session", "fail"],
			["passes", "pass"],
		]);
		expect(outcomes[1]?.detail).toBe(
			"not checked: no session (the sign-in check did not pass)",
		);
	});

	test("the report says the result first, groups the checks, and carries a failure's evidence", () => {
		const report = markdown(
			[
				{
					group: "control",
					name: "a | b",
					status: "pass",
					detail: "fine",
					ms: 1,
				},
				{
					group: "web",
					name: "sign-in",
					status: "fail",
					detail: "refused",
					evidence: "GET /x → 500",
					ms: 1,
				},
				{
					group: "web",
					name: "later",
					status: "skipped",
					detail: "no session",
					ms: 0,
				},
			],
			{ Environment: "check" },
		);
		expect(report).toContain(
			"- **Result:** FAIL — 1 passed, 1 failed, 1 skipped",
		);
		expect(report).toContain("| ✓ | a \\| b | fine |");
		expect(report).toContain("## web");
		expect(report).toContain("### sign-in\n\n```\nGET /x → 500\n```");
	});
});

describe("what a run makes is taken back", () => {
	/** A frontend that answers every delete, and writes down what it was asked. */
	function standInFrontend(answer: (method: string, path: string) => number) {
		const asked: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const path = new URL(req.url).pathname;
				asked.push(`${req.method} ${path}`);
				return new Response(null, { status: answer(req.method, path) });
			},
		});
		return { server, asked, origin: `http://localhost:${server.port}` };
	}

	function madeContext(origin: string) {
		const ctx = contextFor({}, OPTIONS, async () => null, origin);
		const jar = new Jar();
		jar.cookies.set("session", "s");
		ctx.made.push(jar);
		ctx.session = { jar, own: true };
		ctx.threads.add("thread-1");
		return ctx;
	}

	test("a session given in VERIFY_SESSION_COOKIE is never the run's own, so nothing of that person is erased or deleted", async () => {
		const web = standInFrontend(() => 200);
		const before = process.env.VERIFY_SESSION_COOKIE;
		process.env.VERIFY_SESSION_COOKIE = "session=given";
		try {
			const ctx = contextFor(
				{ AUTH_MODE: "entra" },
				OPTIONS,
				async () => null,
				web.origin,
			);
			const check = CHECKS.find((c) => c.name === "sign-in holds a session");
			if (!check) throw new Error("no sign-in check");
			const outcomes = await runChecks([check], ctx, () => {});
			expect(outcomes[0]?.status).toBe("pass");
			expect(ctx.session?.own).toBe(false);
			expect(ctx.made).toHaveLength(0);
		} finally {
			if (before === undefined) delete process.env.VERIFY_SESSION_COOKIE;
			else process.env.VERIFY_SESSION_COOKIE = before;
			web.server.stop(true);
		}
	});

	test("a check that throws still has the account and its conversations deleted", async () => {
		const web = standInFrontend(() => 204);
		try {
			const ctx = madeContext(web.origin);
			const outcomes = await runChecks(
				[
					{
						group: "web",
						name: "throws",
						run: async () => {
							throw new Error("mid-way");
						},
					},
				],
				ctx,
			);
			expect(web.asked).toEqual([
				"DELETE /api/conversations/thread-1",
				"DELETE /api/account",
			]);
			expect(outcomes.at(-1)).toMatchObject({
				name: "what the run made is taken back",
				status: "pass",
			});
		} finally {
			web.server.stop(true);
		}
	});

	test("a delete that gets no answer is reported as left behind, not taken for done", async () => {
		const ctx = madeContext("http://127.0.0.1:9");
		const outcomes = await runChecks([], ctx);
		const taken = outcomes.at(-1) as Outcome;
		expect(taken.status).toBe("fail");
		expect(taken.detail).toContain("conversation thread-1 (no answer)");
		expect(taken.detail).toContain(
			'the account named "Verify deployment" (no answer)',
		);
	});

	test("a run stopped by a signal deletes what it made, writes its report and exits by the signal", async () => {
		const web = standInFrontend(() => 204);
		const dir = mkdtempSync(join(work, "signal-"));
		const report = join(dir, "report.json");
		const script = join(dir, "run.ts");
		writeFileSync(
			script,
			`import { writeFileSync } from "node:fs";
import { Jar, contextFor, onSignals, parseArgs, runChecks } from ${JSON.stringify(join(import.meta.dir, "verify-deployment.ts"))};
const ctx = contextFor({}, parseArgs([]), async () => null, ${JSON.stringify(web.origin)});
const jar = new Jar();
jar.cookies.set("session", "s");
ctx.made.push(jar);
ctx.session = { jar, own: true };
ctx.threads.add("thread-1");
onSignals(ctx, () => {}, (outcomes) => writeFileSync(${JSON.stringify(report)}, JSON.stringify(outcomes)), { child: 5_000, current: 200 });
await runChecks([{ group: "telemetry", name: "waits", run: async () => { console.log("waiting"); await Bun.sleep(60_000); return { status: "pass", detail: "" }; } }], ctx);
`,
		);
		try {
			const child = Bun.spawn(["bun", script], { stdout: "pipe" });
			const reader = child.stdout.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain("waiting");
			child.kill("SIGTERM");
			expect(await child.exited).toBe(143);
			expect(web.asked).toEqual([
				"DELETE /api/conversations/thread-1",
				"DELETE /api/account",
			]);
			const outcomes = JSON.parse(readFileSync(report, "utf8")) as Outcome[];
			expect(outcomes.at(-1)).toMatchObject({
				name: "what the run made is taken back",
				status: "pass",
			});
		} finally {
			web.server.stop(true);
		}
	});
});

describe("ingest, run by the destructive check", () => {
	const printEnv = [
		"bash",
		"-c",
		'echo "environment=$AZURE_ENV_NAME account=sttok"',
		"ingest",
	];

	test("the child reads the environment the run checks, not azd's default", async () => {
		const ctx = contextFor({}, parseArgs(["--env", "other"]), async () => null);
		ctx.ingest = printEnv;
		const before = process.env.AZURE_ENV_NAME;
		process.env.AZURE_ENV_NAME = "default-one";
		try {
			const { code, output } = await runIngest(ctx, ["--remove", "x"]);
			expect(code).toBe(0);
			expect(output).toContain("environment=other");
		} finally {
			if (before === undefined) delete process.env.AZURE_ENV_NAME;
			else process.env.AZURE_ENV_NAME = before;
		}
	});

	test("an ingest that acted on another storage account fails the check", async () => {
		const check = CHECKS.find(
			(c) =>
				c.name === "ingest through --open-listener leaves the account closed",
		);
		const env = {
			AZURE_ENV_NAME: "check",
			PRIVATE_NETWORKING: "true",
			AZURE_STORAGE_ACCOUNT: "stthisone",
		};
		const ctx = contextFor(env, parseArgs(["--destructive"]), async () => null);
		ctx.ingest = printEnv;
		const outcomes = await runChecks([check as (typeof CHECKS)[number]], ctx);
		expect(outcomes[0]).toMatchObject({ status: "fail" });
		expect(outcomes[0]?.detail).toContain(
			"ingest did not act on this environment's storage account stthisone",
		);
	});
});

describe("a run that cannot be made as asked is refused, never passed half checked", () => {
	const web = selected(parseArgs(["--only", "web"]));
	const all = selected(parseArgs([]));

	test("under entra with no session and no --signed-out-only, the run is refused and says how to give one", () => {
		const env = { AZURE_SUBSCRIPTION_ID: SUB, HARDENED: "true" };
		expect(refusedRun(env, parseArgs([]), all, undefined)).toContain(
			"VERIFY_SESSION_COOKIE",
		);
		expect(refusedRun(env, parseArgs([]), all, "session=s")).toBeNull();
		expect(
			refusedRun(env, parseArgs(["--signed-out-only"]), all, undefined),
		).toBeNull();
		expect(
			refusedRun(
				{ AZURE_SUBSCRIPTION_ID: SUB, AUTH_MODE: "local" },
				parseArgs([]),
				all,
				undefined,
			),
		).toBeNull();
	});

	test("a session given in VERIFY_SESSION_COOKIE is a real person's: --destructive beside it is refused, so the erase is never skipped green", () => {
		const env = { AZURE_SUBSCRIPTION_ID: SUB, HARDENED: "true" };
		expect(
			refusedRun(env, parseArgs(["--destructive"]), all, "session=s"),
		).toContain("never erased");
		expect(
			refusedRun(env, parseArgs(["--voice"]), all, "session=s"),
		).toBeNull();
	});

	test("--signed-out-only cannot be asked beside the checks that need a session", () => {
		expect(() => parseArgs(["--signed-out-only", "--voice"])).toThrow(
			"--signed-out-only",
		);
		expect(() => parseArgs(["--signed-out-only", "--destructive"])).toThrow(
			"--signed-out-only",
		);
	});

	test("a selection that asks Azure needs the subscription; one that does not, does not", () => {
		expect(refusedRun({}, parseArgs([]), all, undefined)).toContain(
			"AZURE_SUBSCRIPTION_ID",
		);
		expect(
			refusedRun({}, parseArgs(["--only", "web"]), web, undefined),
		).toBeNull();
		const privateDestructive = selected(
			parseArgs(["--only", "destructive", "--destructive"]),
		);
		expect(
			refusedRun(
				{ PRIVATE_NETWORKING: "true", AUTH_MODE: "local" },
				parseArgs(["--only", "destructive", "--destructive"]),
				privateDestructive,
				undefined,
			),
		).toContain("AZURE_SUBSCRIPTION_ID");
	});

	test("a signed-in check with no session fails; skips only when the operator asked for a signed-out run", async () => {
		const check = CHECKS.find(
			(c) => c.name === "a typed turn streams an answer",
		);
		for (const [args, status] of [
			[[], "fail"],
			[["--signed-out-only"], "skipped"],
		] as const) {
			const ctx = contextFor({}, parseArgs([...args]), async () => null);
			const [outcome] = await runChecks(
				[check as (typeof CHECKS)[number]],
				ctx,
			);
			expect(outcome?.status).toBe(status);
		}
	});

	test("a stopped run's report says INTERRUPTED and what it did not reach, never PASS", () => {
		const outcomes: Outcome[] = [
			{ group: "web", name: "a", status: "pass", detail: "", ms: 1 },
		];
		expect(verdict(outcomes)).toBe("PASS");
		const interrupted = { signal: "SIGINT", notRun: ["b", "c"] };
		expect(verdict(outcomes, interrupted)).toBe("INTERRUPTED");
		const report = markdown(outcomes, {}, interrupted);
		expect(report).toContain("**Result:** INTERRUPTED");
		expect(report).toContain("not run: b; c");
		expect(report).not.toContain("PASS");
	});
});

describe("a live session is judged by how it ended", () => {
	const good: LiveRun = {
		events: ["ready", "ending", "ended"],
		errors: [],
		ending: "client",
		ended: { reason: "client", written: 0 },
		close: 1000,
	};
	test("ready, no error, ended for the run's own end, closed 1000: sound", () => {
		expect(liveProblem(good)).toBeNull();
	});
	for (const [what, run, words] of [
		["never ready", { ...good, events: ["ended"] }, "never became ready"],
		[
			"an error event",
			{ ...good, errors: ["turn.blocked"] },
			"error turn.blocked",
		],
		[
			"refused after ready",
			{ ...good, ending: "refused", ended: { reason: "refused", written: 0 } },
			"refused",
		],
		[
			"the socket failed",
			{ ...good, ending: undefined, ended: { reason: "failed", written: 0 } },
			"ended failed",
		],
		[
			"the service closed it",
			{ ...good, ending: undefined, ended: { reason: "service", written: 0 } },
			"ended service",
		],
		["no ended message", { ...good, ended: undefined }, "no ended message"],
		["closed 1011", { ...good, close: 1011 }, "closed 1011"],
	] as const)
		test(`${what} fails`, () => {
			expect(liveProblem(run as LiveRun)).toContain(words);
		});
});

describe("the control checks read what a fresh environment holds", () => {
	test("a vault whose secrets come on two pages holds every one of them", async () => {
		const h = healthy({ hardened: true });
		const list = `${h.services.vault.id}/secrets`;
		const next = `https://management.azure.com${list}?api-version=2023-07-01&$skiptoken=abc`;
		h.answers.set(key(call.get(list, "2023-07-01")), {
			value: SECRETS.slice(0, 2).map((name) => ({ name })),
			nextLink: next,
		});
		h.answers.set(key(call.page(next)), {
			value: SECRETS.slice(2).map((name) => ({ name })),
		});
		const { outcomes, calls } = await runControl(h.env, h.answers);
		expect(byName(outcomes, "Key Vault holds").status).toBe("pass");
		expect(calls.map((c) => c.key)).toContain(key(call.page(next)));
	});

	test("a page that names itself as the next one fails rather than asking for ever", async () => {
		const h = healthy({ hardened: true });
		const list = `${h.services.vault.id}/secrets`;
		const next = `https://management.azure.com${list}?api-version=2023-07-01&$skiptoken=abc`;
		h.answers.set(key(call.get(list, "2023-07-01")), {
			value: [],
			nextLink: next,
		});
		h.answers.set(key(call.page(next)), { value: [], nextLink: next });
		const { outcomes } = await runControl(h.env, h.answers);
		expect(byName(outcomes, "Key Vault holds").status).toBe("fail");
	});

	for (const jumpHost of [false, true])
		test(`an environment that stores no principal is checked against the one its latest succeeded deployment was given${jumpHost ? ", Redis's policy too" : ""}`, async () => {
			const h = healthy({ hardened: true, jumpHost });
			delete h.env.AZURE_PRINCIPAL_ID;
			h.answers.set(key(call.deployments("check")), [
				{
					name: "check-1",
					properties: {
						provisioningState: "Succeeded",
						timestamp: "2030-01-01T00:00:00Z",
						parameters: {
							principalId: { value: "someone-else" },
							principalType: { value: "User" },
						},
					},
				},
				{
					name: "check-2",
					properties: {
						provisioningState: "Succeeded",
						timestamp: "2030-01-02T00:00:00Z",
						parameters: {
							principalId: { value: "deployer-oid" },
							principalType: { value: "User" },
							operatorPrincipalId: { value: "" },
						},
					},
				},
				{
					name: "check-3",
					properties: {
						provisioningState: "Failed",
						timestamp: "2030-01-03T00:00:00Z",
						parameters: { principalId: { value: "someone-else" } },
					},
				},
			]);
			const { outcomes } = await runControl(h.env, h.answers);
			const roles = byName(outcomes, "the operator holds");
			expect(roles.status).toBe("pass");
			expect(roles.detail).toContain(
				"deployer-oid (from the deployment check-2)",
			);
			expect(byName(outcomes, "Redis admits").status).toBe("pass");
		});

	test("a deployment that named an operator is checked against the operator", async () => {
		const h = healthy({ hardened: true, operatorGroup: true });
		delete h.env.AZURE_PRINCIPAL_ID;
		delete h.env.OPERATOR_PRINCIPAL_ID;
		delete h.env.OPERATOR_PRINCIPAL_TYPE;
		h.answers.set(key(call.deployments("check")), [
			{
				name: "check-1",
				properties: {
					provisioningState: "Succeeded",
					timestamp: "2030-01-01T00:00:00Z",
					parameters: {
						principalId: { value: "deployer-oid" },
						operatorPrincipalId: { value: "group-oid" },
						operatorPrincipalType: { value: "Group" },
					},
				},
			},
		]);
		const { outcomes } = await runControl(h.env, h.answers);
		expect(byName(outcomes, "the operator holds").detail).toContain(
			"group-oid",
		);
	});
});

describe("telemetry counts this run's own rows", () => {
	const TENANT = "tenant-of-the-environment";
	const TOKEN = "token-value-never-reported";
	const APP = "11111111-2222-3333-4444-555555555555";
	const env = {
		AZURE_SUBSCRIPTION_ID: SUB,
		AZURE_TENANT_ID: TENANT,
		APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=k;ApplicationId=${APP}`,
	};
	const check = CHECKS.find(
		(c) => c.group === "telemetry",
	) as (typeof CHECKS)[number];

	/** The API answers `answer`, as JSON with 200 or as the `Response` given. */
	async function run(
		answer: unknown,
		environment: Record<string, string> = env,
	) {
		const ctx = contextFor(environment, OPTIONS, async () => null);
		ctx.turns.push({
			start: new Date("2030-01-01T00:00:10Z"),
			end: new Date("2030-01-01T00:00:20Z"),
		});
		ctx.started = new Date("2030-01-01T00:00:00Z");
		const asked: string[][] = [];
		const sent: { url: string; auth: string | null; body: unknown }[] = [];
		ctx.az = async (args) => {
			asked.push(args);
			return { accessToken: TOKEN };
		};
		ctx.insights = async (url, init) => {
			sent.push({
				url,
				auth: new Headers(init.headers).get("authorization"),
				body: JSON.parse(String(init.body)),
			});
			if (answer instanceof Error) throw answer;
			return answer instanceof Response
				? answer.clone()
				: Response.json(answer);
		};
		ctx.pause = async () => {};
		const [outcome] = await runChecks([check], ctx);
		return { outcome, asked, sent, query: usageQuery(ctx) };
	}

	test("rows of this run's turns pass", async () => {
		const { outcome, sent, query } = await run({
			tables: [{ rows: [["llm_usage", 2]] }],
		});
		expect(outcome?.status).toBe("pass");
		expect(sent[0]?.url).toBe(`${INSIGHTS_API}/v1/apps/${APP}/query`);
		expect(sent[0]?.body).toEqual({ query, timespan: "PT1H" });
	});

	test("the query is made with a token for the environment's tenant, not the CLI's default one", async () => {
		const { asked, sent } = await run({
			tables: [{ rows: [["llm_usage", 1]] }],
		});
		expect(asked).toEqual([call.insightsToken(TENANT)]);
		expect(asked[0]).toEqual([
			"account",
			"get-access-token",
			"--resource",
			INSIGHTS_API,
			"--tenant",
			TENANT,
		]);
		expect(sent[0]?.auth).toBe(`Bearer ${TOKEN}`);
		// No `az monitor app-insights query`: it takes the default subscription's tenant.
		expect(asked.flat()).not.toContain("app-insights");
	});

	test("an environment that names no tenant asks for the token in its subscription's", async () => {
		const { AZURE_TENANT_ID: _, ...untenanted } = env;
		const { asked, outcome } = await run(
			{ tables: [{ rows: [["llm_usage", 1]] }] },
			untenanted,
		);
		expect(outcome?.status).toBe("pass");
		expect(asked[0]).not.toContain("--tenant");
	});

	test("a call naming its tenant is not given the subscription too, which az refuses beside it", async () => {
		const az = standInAz(
			new Map([
				[key(call.insightsToken(TENANT)), { accessToken: TOKEN }],
				[key(call.group("rg")), {}],
			]),
		);
		const real = realAz(SUB, az.program);
		await real(call.insightsToken(TENANT));
		await real(call.group("rg"));
		expect(az.calls().map((c) => c.subscription)).toEqual(["", SUB]);
	});

	test("the backend's rows are matched by the turn's window, never by the client's run id, which the backend does not keep", async () => {
		const { query } = await run({ tables: [{ rows: [["llm_usage", 1]] }] });
		expect(query).not.toContain("turn_tag");
		expect(query).toContain('cloud_RoleName == "assistant-backend"');
		expect(query).toContain(
			"timestamp between (datetime(2029-12-31T23:59:10.000Z) .. datetime(2030-01-01T00:01:20.000Z))",
		);
	});

	test("no row after the wait fails", async () => {
		const { outcome, sent } = await run({ tables: [{ rows: [] }] });
		expect(outcome?.status).toBe("fail");
		expect(sent.length).toBe(10);
	});

	test("a row counted zero fails", async () => {
		const { outcome } = await run({ tables: [{ rows: [["llm_usage", 0]] }] });
		expect(outcome?.status).toBe("fail");
	});

	test("a token the API refuses fails at once, naming the tenant to sign in to and never the token", async () => {
		const { outcome, sent } = await run(
			Response.json(
				{ error: { code: "InvalidTokenError", message: "wrong tenant" } },
				{ status: 401 },
			),
		);
		expect(outcome?.status).toBe("fail");
		expect(sent.length).toBe(1);
		expect(outcome?.detail).toContain("not permitted here");
		expect(outcome?.detail).toContain(`az login --tenant ${TENANT}`);
		expect(JSON.stringify(outcome)).not.toContain(TOKEN);
	});

	test("a query this identity may not make fails, saying what to fix", async () => {
		const { outcome } = await run(
			Response.json(
				{ error: { code: "InsufficientAccessError" } },
				{ status: 403 },
			),
		);
		expect(outcome?.status).toBe("fail");
		expect(outcome?.detail).toContain("not permitted here");
	});

	test("an API that does not answer fails the check", async () => {
		const { outcome } = await run(new Error("connection reset"));
		expect(outcome?.status).toBe("fail");
	});
});

/**
 * A frontend stood in for, as the deployed app answers each route the web,
 * voice and erase checks ask of it, with `faults` naming what it gets wrong.
 * Healthy, every check passes; each fault is one thing a broken deployment
 * would show, and the check that exists for it must fail.
 */
function standInApp(faults: ReadonlySet<string> = new Set()) {
	type Person = {
		erased: boolean;
		threads: Map<string, { title?: string; text: string; gone?: boolean }>;
	};
	const people = new Map<string, Person>();
	let counter = 0;
	const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
		Response.json(body, { status, headers });
	const csp = (nonce: string) =>
		[
			"default-src 'self'",
			faults.has("unsafe-inline")
				? `script-src 'self' 'unsafe-inline'`
				: `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
			"style-src 'self' 'unsafe-inline'",
			faults.has("no object-src") ? "" : "object-src 'none'",
			"base-uri 'self'",
			"form-action 'self'",
			"frame-ancestors 'none'",
			"frame-src 'none'",
		]
			.filter(Boolean)
			.join("; ");
	const page = (signedInPage: boolean) => {
		const nonce = faults.has("same nonce") ? "fixed" : `n${counter++}`;
		const bare = signedInPage && faults.has("signed-in page without nonce");
		return new Response(
			`<html><script nonce="${bare ? "" : nonce}">1</script></html>`,
			{
				headers: {
					"content-type": "text/html",
					"content-security-policy": bare
						? "default-src 'self'; script-src 'self'"
						: csp(nonce),
					"x-content-type-options": "nosniff",
					"x-frame-options": "DENY",
					"referrer-policy": "strict-origin-when-cross-origin",
				},
			},
		);
	};
	const personOf = (req: Request) => {
		const sid = /(?:^|; )session=([^;]+)/.exec(
			req.headers.get("cookie") ?? "",
		)?.[1];
		return sid ? { sid, person: people.get(sid) } : null;
	};
	const server = Bun.serve<{ sid: string }, unknown>({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			const path = url.pathname;
			const me = personOf(req);
			const live = me?.person && !me.person.erased ? me.person : undefined;
			if (path === "/health")
				return new Response("ok", { status: faults.has("health") ? 503 : 200 });
			if (path === "/login" || path === "/privacy") return page(false);
			if (path === "/chat" || path === "/settings")
				return live
					? page(true)
					: new Response(null, {
							status: 302,
							headers: { location: "/login" },
						});
			if (path === "/voice/capture-worklet.js")
				return new Response("worklet", {
					headers: faults.has("static cookie")
						? { "set-cookie": "authjs.session-token=secret-value; Path=/" }
						: {},
				});
			if (path === "/api/appearance/logo")
				return faults.has("logo") || faults.has("logo cookie")
					? new Response("png", {
							headers: {
								"content-type": "image/png",
								"cache-control": "public, max-age=300",
								...(faults.has("logo cookie")
									? { "set-cookie": "__Host-authjs.csrf-token=c; Path=/" }
									: {}),
							},
						})
					: new Response(null, {
							status: faults.has("logo 502") ? 502 : 404,
						});
			if (path === "/api/auth/csrf")
				return json({ csrfToken: "t" }, 200, {
					"set-cookie": "authjs.csrf-token=c; Path=/",
				});
			if (path === "/api/auth/signin/microsoft-entra-id") {
				const client = faults.has("entra unset")
					? "unset"
					: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
				return new Response(null, {
					status: 302,
					headers: {
						location: faults.has("entra error")
							? `${url.origin}/api/auth/error?error=Configuration`
							: `https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize?client_id=${client}&state=s`,
					},
				});
			}
			if (path === "/api/auth/callback/local") {
				if (faults.has("sign-in")) return new Response(null, { status: 500 });
				const sid = `s${counter++}`;
				people.set(sid, { erased: false, threads: new Map() });
				return new Response(null, {
					status: 302,
					headers: {
						location: "/chat",
						"set-cookie": `session=${sid}; Path=/`,
					},
				});
			}
			if (path === "/api/voice/live") {
				if (!live) return new Response(null, { status: 401 });
				return srv.upgrade(req, { data: { sid: me?.sid ?? "" } })
					? undefined
					: new Response(null, { status: 400 });
			}
			if (path.startsWith("/api/")) {
				if (!me?.person)
					return json(
						{ code: "unauthenticated" },
						faults.has("api open") ? 200 : 401,
					);
				// The app's own rule: the session of an erased account may ask the erase again, and nothing else.
				if (me.person.erased)
					return path === "/api/account" && req.method === "DELETE"
						? new Response(null, { status: 204 })
						: json({ code: "account_erased" }, 401);
			}
			if (!live) return new Response("not found", { status: 404 });
			if (path === "/api/me" && req.method === "PATCH") {
				const origin = req.headers.get("origin");
				const foreign = origin && origin !== url.origin;
				return new Response(null, {
					status: foreign && !faults.has("foreign origin") ? 403 : 200,
				});
			}
			if (path === "/api/copilotkit") {
				if (faults.has("turn 500")) return new Response("no", { status: 500 });
				return req
					.json()
					.then(
						(body: {
							body: { threadId: string; messages: { content: string }[] };
						}) => {
							const text = body.body.messages[0]?.content ?? "";
							live.threads.set(body.body.threadId, { text });
							return new Response(
								faults.has("turn error")
									? 'data: {"type":"RUN_ERROR"}\n\n'
									: 'data: {"type":"TEXT_MESSAGE_CONTENT"}\n\ndata: {"type":"RUN_FINISHED"}\n\n',
								{ headers: { "content-type": "text/event-stream" } },
							);
						},
					);
			}
			if (path === "/api/conversations")
				return json({
					conversations: [...live.threads]
						.filter(([, t]) => !t.gone)
						.map(([id]) => ({ id })),
				});
			const thread = /^\/api\/conversations\/([^/]+)$/.exec(path)?.[1];
			if (thread) {
				const held = live.threads.get(thread);
				if (!held || held.gone) return json({ code: "not_found" }, 404);
				if (req.method === "PATCH")
					return new Response(null, {
						status: faults.has("rename") ? 500 : 200,
					});
				if (req.method === "DELETE") {
					held.gone = true;
					return new Response(null, { status: 204 });
				}
				return json({ messages: [{ text: held.text }] });
			}
			if (path === "/api/library")
				return json({
					documents: faults.has("library empty")
						? []
						: [
								{
									title: "Onboarding handbook",
									...(faults.has("no picture")
										? {}
										: { thumbnailUrl: "/api/media/sample/pic.png" }),
								},
							],
				});
			if (path.startsWith("/api/media/")) {
				const asked = req.headers.get("if-none-match");
				const revalidated =
					(asked === '"e1"' && !faults.has("no 304")) ||
					(asked === "*" && faults.has("star 304"));
				return new Response(revalidated ? null : "png", {
					status: revalidated ? 304 : 200,
					headers: { "content-type": "image/png", etag: '"e1"' },
				});
			}
			if (path === "/api/account/export")
				return faults.has("export html")
					? new Response("<html>", { status: 200 })
					: json({
							conversations: [...live.threads.values()]
								.filter((t) => !t.gone)
								.map((t) => t.text),
						});
			if (path === "/api/voice/capability")
				return json({ live: !faults.has("no voice") });
			if (path === "/api/account" && req.method === "DELETE") {
				if (!faults.has("erase keeps sessions")) live.erased = true;
				return new Response(null, { status: 204 });
			}
			if (path === "/api/nope")
				return faults.has("api html 404")
					? new Response("<html>404</html>", { status: 404 })
					: json({ code: "not_found" }, 404);
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				if (typeof message !== "string") return;
				const event = JSON.parse(message) as { type: string };
				if (event.type === "start") {
					ws.send(JSON.stringify({ type: "ready" }));
					if (faults.has("voice refused after ready")) {
						ws.send(JSON.stringify({ type: "ending", reason: "refused" }));
						ws.send(
							JSON.stringify({ type: "ended", reason: "refused", written: 0 }),
						);
						ws.close(1000);
					}
					if (faults.has("voice error"))
						ws.send(JSON.stringify({ type: "error", code: "turn.blocked" }));
				}
				if (event.type === "end") {
					ws.send(JSON.stringify({ type: "ending", reason: "client" }));
					ws.send(
						JSON.stringify({ type: "ended", reason: "client", written: 0 }),
					);
					ws.close(faults.has("voice close 1011") ? 1011 : 1000);
				}
			},
		},
	});
	return { server, origin: `http://localhost:${server.port}`, people };
}

/** The web, voice and erase checks, in their order. */
const signedInGroups = CHECKS.filter((c) =>
	["web", "voice", "destructive"].includes(c.group),
);

async function runAgainst(faults: string[] = []) {
	const app = standInApp(new Set(faults));
	try {
		const ctx = contextFor(
			{ AUTH_MODE: "local", SEED_SAMPLE_LIBRARY: "true" },
			parseArgs(["--voice", "--destructive", "--allow-http"]),
			async () => null,
			app.origin,
		);
		return await runChecks(signedInGroups, ctx);
	} finally {
		app.server.stop(true);
	}
}

describe("the web, voice and erase checks, against a frontend stood in for", () => {
	test("healthy: every check passes, and what a local run has none of is skipped", async () => {
		const outcomes = await runAgainst();
		expect(failed(outcomes)).toEqual([]);
		expect(
			outcomes.filter((o) => o.status === "skipped").map((o) => o.name),
		).toEqual([
			"the backend is not reachable from outside",
			"sign-in goes to Entra with a real client id",
			"ingest through --open-listener leaves the account closed",
		]);
	});

	for (const [fault, check] of [
		["health", "the frontend answers /health"],
		["same nonce", "pages carry a nonce policy"],
		["unsafe-inline", "pages carry a nonce policy"],
		["no object-src", "pages carry a nonce policy"],
		["static cookie", "a public file sets no cookie"],
		["logo cookie", "a public file sets no cookie"],
		["logo 502", "a public file sets no cookie"],
		["api open", "the API refuses a caller with no session"],
		["signed-in page without nonce", "signed-in pages carry the same policy"],
		["api html 404", "an unknown API path answers as an API does"],
		["foreign origin", "a write from another origin is refused"],
		["turn 500", "a typed turn streams an answer"],
		["turn error", "a typed turn streams an answer"],
		["rename", "a conversation is listed, renamed, read and deleted"],
		["library empty", "the library lists its documents"],
		["no picture", "a picture is served and revalidated"],
		["no 304", "a picture is served and revalidated"],
		["star 304", "a picture is served and revalidated"],
		["export html", "the export downloads"],
		["no voice", "live voice is offered"],
		["voice refused after ready", "a live session opens"],
		["voice error", "a live session opens"],
		["voice close 1011", "a live session opens"],
		["erase keeps sessions", "an erase ends every session"],
		["sign-in", "sign-in holds a session"],
	] as const)
		test(`a frontend with "${fault}" fails "${check}…"`, async () => {
			const outcomes = await runAgainst([fault]);
			expect(failed(outcomes)).toContain(
				(outcomes.find((o) => o.name.startsWith(check)) as Outcome).name,
			);
		});

	test("a deployment that names a logo passes when it sets no cookie, as one that names none does", async () => {
		const outcomes = await runAgainst(["logo"]);
		expect(failed(outcomes)).toEqual([]);
		expect(
			outcomes.find((o) => o.name === "a public file sets no cookie")?.detail,
		).toContain("the logo 200");
	});

	test("a broken sign-in fails every check that needs a session, never skips it", async () => {
		const outcomes = await runAgainst(["sign-in"]);
		const signedIn = outcomes.filter((o) =>
			o.detail.startsWith("not checked: no session"),
		);
		expect(signedIn.length).toBeGreaterThan(8);
		expect(signedIn.every((o) => o.status === "fail")).toBe(true);
	});

	test("evidence names a cookie and never carries its value", async () => {
		const outcomes = await runAgainst(["static cookie"]);
		const text = JSON.stringify(outcomes);
		expect(text).toContain("authjs.session-token");
		expect(text).not.toContain("secret-value");
	});
});

describe("the signed-out checks that need no session of their own", () => {
	const entra = CHECKS.find(
		(c) => c.name === "sign-in goes to Entra with a real client id",
	) as (typeof CHECKS)[number];

	async function entraRun(faults: string[], env: Record<string, string> = {}) {
		const app = standInApp(new Set(faults));
		try {
			const ctx = contextFor(
				{ AUTH_MODE: "entra", ...env },
				parseArgs(["--signed-out-only"]),
				async () => null,
				app.origin,
			);
			const [outcome] = await runChecks([entra], ctx);
			return outcome as Outcome;
		} finally {
			app.server.stop(true);
		}
	}

	test("Entra: a redirect naming a real client id of this environment passes", async () => {
		const outcome = await entraRun([], {
			AUTH_MICROSOFT_ENTRA_ID_ID: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
			AZURE_TENANT_ID: "tenant-1",
		});
		expect(outcome.status).toBe("pass");
		expect(JSON.stringify(outcome)).not.toContain("state=");
	});

	for (const [what, faults, env] of [
		["a placeholder client id", ["entra unset"], {}],
		["a provider that fails to set up", ["entra error"], {}],
		[
			"another environment's client id",
			[],
			{ AUTH_MICROSOFT_ENTRA_ID_ID: "11111111-1111-1111-1111-111111111111" },
		],
		["another tenant", [], { AZURE_TENANT_ID: "tenant-2" }],
	] as const)
		test(`Entra: ${what} fails`, async () => {
			expect((await entraRun([...faults], env)).status).toBe("fail");
		});

	const reach = CHECKS.find(
		(c) => c.name === "the backend is not reachable from outside",
	) as (typeof CHECKS)[number];
	for (const [what, answer, status] of [
		["no connection", new Error("getaddrinfo ENOTFOUND"), "pass"],
		[
			"the platform's own page",
			new Response(
				"Error 404 - This Container App is stopped or does not exist.",
				{ status: 404 },
			),
			"pass",
		],
		["an answer", new Response("ok", { status: 200 }), "fail"],
		["an app's 503", new Response("down", { status: 503 }), "fail"],
		["an app's own 404", new Response("{}", { status: 404 }), "fail"],
	] as const)
		test(`the backend from outside: ${what} → ${status}`, async () => {
			const ctx = contextFor(
				{ BACKEND_URL: "https://ca-backend.internal.example" },
				OPTIONS,
				async () => null,
			);
			ctx.probe = async () =>
				answer instanceof Response ? answer.clone() : answer;
			const [outcome] = await runChecks([reach], ctx);
			expect(outcome?.status).toBe(status);
		});
});

describe("a signal during the ingest the destructive check runs", () => {
	test("the child is told and waited for, its close runs to its end, and the report names the library and the account left open", async () => {
		const dir = mkdtempSync(join(work, "ingest-signal-"));
		const closed = join(dir, "closed");
		const report = join(dir, "report.json");
		// The trap shape of scripts/ingest.sh: a close that writes as it goes, after a pause.
		const fake = join(dir, "ingest.sh");
		writeFileSync(
			fake,
			`#!/bin/bash
on_exit() {
	trap '' TERM HUP INT
	sleep 1
	echo "ingest: closing the listener"
	echo "ingest: the public listener is off again"
	touch ${JSON.stringify(closed)}
}
trap on_exit EXIT
trap 'exit 143' TERM
echo "ingest: account=stthisone opened"
sleep 60 & wait $!
`,
		);
		chmodSync(fake, 0o755);
		const script = join(dir, "run.ts");
		writeFileSync(
			script,
			`import { writeFileSync } from "node:fs";
import { CHECKS, contextFor, interruptionOf, onSignals, parseArgs, runChecks } from ${JSON.stringify(join(import.meta.dir, "verify-deployment.ts"))};
const env = { AZURE_ENV_NAME: "check", PRIVATE_NETWORKING: "true", AZURE_STORAGE_ACCOUNT: "stthisone", AZURE_RESOURCE_GROUP: "rg" };
const ctx = contextFor(env, parseArgs(["--destructive"]), async (args) => {
	if (args[0] === "resource") return [{ id: "/x/sttok", name: "sttok", type: "Microsoft.Storage/storageAccounts" }];
	// Read again after the run: the account is still open, with the run's tag.
	return { tags: { ingestListener: "run:203.0.113.7:listener+rule:1" }, properties: { publicNetworkAccess: "Enabled" } };
});
ctx.ingest = ["bash", ${JSON.stringify(fake)}];
const check = CHECKS.find((c) => c.name === "ingest through --open-listener leaves the account closed");
onSignals(ctx, () => {}, (outcomes) => writeFileSync(${JSON.stringify(report)}, JSON.stringify({ interrupted: interruptionOf(ctx, outcomes), outcomes })), { child: 10_000, current: 5_000 });
console.log("started");
await runChecks([check], ctx);
`,
		);
		const child = Bun.spawn(["bun", script], { stdout: "pipe" });
		const reader = child.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"started",
		);
		// The load is under way before the signal.
		await Bun.sleep(500);
		child.kill("SIGTERM");
		expect(await child.exited).toBe(143);
		expect(readFileSync(closed, "utf8")).toBe("");
		const written = JSON.parse(readFileSync(report, "utf8")) as {
			interrupted: { signal: string };
			outcomes: Outcome[];
		};
		expect(written.interrupted.signal).toBe("SIGTERM");
		const ingest = written.outcomes.find((o) => o.name.startsWith("ingest"));
		expect(ingest?.status).toBe("fail");
		// The child's own words, read to its end, are in the evidence.
		expect(ingest?.evidence).toContain("the public listener is off again");
		const taken = written.outcomes.at(-1) as Outcome;
		expect(taken.status).toBe("fail");
		expect(taken.detail).toMatch(
			/the library "verify-[0-9a-f]{8}" may be loaded/,
		);
		expect(taken.detail).toContain("the storage account may be open");
	}, 30_000);
});

test("a run stopped part way names the checks it never reached, and a finished run names none", async () => {
	const ctx = contextFor({}, OPTIONS, async () => null);
	ctx.planned = CHECKS.filter((c) => c.group === "web").slice(0, 3);
	const reached: Outcome[] = [
		{
			name: ctx.planned[0]?.name ?? "",
			group: "web",
			status: "pass",
			detail: "",
			ms: 0,
		},
	];
	expect(interruptionOf(ctx, reached)).toBeUndefined();
	ctx.interrupted = "SIGINT";
	expect(interruptionOf(ctx, reached)).toEqual({
		signal: "SIGINT",
		notRun: ctx.planned.slice(1).map((c) => c.name),
	});
});

test("the exit code says what the report says: a pass is 0, and a failure or an interrupted run is never 0", () => {
	const dir = mkdtempSync(join(work, "report-"));
	const ctx = contextFor({}, OPTIONS, async () => null);
	ctx.planned = CHECKS.filter((c) => c.group === "web").slice(0, 2);
	const outcome = (status: Outcome["status"]): Outcome => ({
		name: ctx.planned[0]?.name ?? "",
		group: "web",
		status,
		detail: "",
		ms: 0,
	});
	const options = { ...OPTIONS, report: join(dir, "r") };
	expect(writeReports(options, {}, ctx, [outcome("pass")])).toBe(0);
	expect(writeReports(options, {}, ctx, [outcome("fail")])).not.toBe(0);
	ctx.interrupted = "SIGINT";
	expect(writeReports(options, {}, ctx, [outcome("pass")])).not.toBe(0);
	const written = JSON.parse(
		readFileSync(`${options.report}.json`, "utf8"),
	) as {
		result: string;
	};
	expect(written.result).toBe("INTERRUPTED");
});
