/**
 * One switch, two shapes. The demo has public endpoints, no network, no edge
 * beyond the Container Apps ingress, nothing locked; hardened has the
 * network with a private endpoint per data service (the Foundry account's
 * registered in the three zones of its three host names), the public
 * listeners off, Front Door, locks and purge protection. The migrate job runs as its own identity;
 * both apps are told which mode they run in.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	allResources,
	compiledMain,
	type Deployment,
	INFRA,
	moduleCalls,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const PRIVATE = [
	"Microsoft.Cache/redisEnterprise",
	"Microsoft.KeyVault/vaults",
	"Microsoft.AppConfiguration/configurationStores",
	"Microsoft.Search/searchServices",
	"Microsoft.CognitiveServices/accounts",
	"Microsoft.DocumentDB/databaseAccounts",
	"Microsoft.Storage/storageAccounts",
];

/** One zone per service, and two more: the Foundry account's services.ai and cognitiveservices host names. */
const ZONES = PRIVATE.length + 2;

function deployment(hardened: boolean): Deployment {
	const d = sampleDeployment({ hardened });
	if (!d) throw new Error("no template");
	return d;
}

function shape(d: Deployment) {
	const live = allResources(d).filter((r) => r.condition);
	const tier = moduleCalls(d).filter((m) => m.path.length === 2);
	// Cosmos DB's module takes the switch inside its network restrictions.
	const publicAccess = Object.fromEntries(
		PRIVATE.map((type) => {
			const p = tier.find((m) => m.mainType === type)?.parameters;
			const restrictions = p?.networkRestrictions as
				| { publicNetworkAccess?: unknown }
				| undefined;
			return [
				type,
				p?.publicNetworkAccess ?? restrictions?.publicNetworkAccess,
			];
		}),
	);
	return {
		privateEndpoints: live.filter(
			(r) => r.type === "Microsoft.Network/privateEndpoints",
		),
		dnsZones: live.filter(
			(r) => r.type === "Microsoft.Network/privateDnsZones",
		),
		networks: live.filter(
			(r) => r.type === "Microsoft.Network/virtualNetworks",
		),
		frontDoors: live.filter((r) => r.type === "Microsoft.Cdn/profiles"),
		locks: live.filter((r) => r.type === "Microsoft.Authorization/locks"),
		publicAccess,
		vault: tier.find((m) => m.mainType === "Microsoft.KeyVault/vaults")
			?.parameters,
		environment: tier.find(
			(m) => m.mainType === "Microsoft.App/managedEnvironments",
		)?.parameters,
	};
}

it("the demo: public listeners, no network, no private endpoint, no Front Door, no lock", () => {
	const s = shape(deployment(false));
	expect(s.networks).toEqual([]);
	expect(s.privateEndpoints).toEqual([]);
	expect(s.dnsZones).toEqual([]);
	expect(s.frontDoors).toEqual([]);
	expect(s.locks).toEqual([]);
	for (const type of PRIVATE)
		expect(s.publicAccess[type], type).toBe("Enabled");
	expect(s.vault?.enablePurgeProtection).toBe(false);
	expect(s.environment?.infrastructureSubnetResourceId).toBeNull();
	expect(s.environment?.zoneRedundant).toBe(false);
});

it("hardened: a network, a private endpoint and a DNS zone per data service, listeners off, Front Door, locks, purge protection, zones", () => {
	const s = shape(deployment(true));
	expect(s.networks).toHaveLength(1);
	expect(s.dnsZones).toHaveLength(ZONES);
	expect(s.privateEndpoints).toHaveLength(PRIVATE.length);
	expect(s.frontDoors).toHaveLength(1);
	expect(s.locks.length).toBeGreaterThan(0);
	for (const type of PRIVATE)
		expect(s.publicAccess[type], type).toBe("Disabled");
	expect(s.vault?.enablePurgeProtection).toBe(true);
	expect(s.environment?.infrastructureSubnetResourceId).toBeTruthy();
	expect(s.environment?.zoneRedundant).toBe(true);
});

it("each switch overrides its part of the bundle, in both directions", () => {
	const opened = shape(
		// Zones go with the network: preprovision refuses one without the other.
		sampleDeployment({
			hardened: true,
			privateNetworking: "false",
			zoneRedundant: "false",
		}) as Deployment,
	);
	expect(opened.privateEndpoints).toEqual([]);
	expect(opened.environment?.zoneRedundant).toBe(false);
	expect(opened.frontDoors).toHaveLength(1);
	const sealed = shape(
		sampleDeployment({
			hardened: false,
			privateNetworking: "true",
		}) as Deployment,
	);
	expect(sealed.privateEndpoints).toHaveLength(PRIVATE.length);
	expect(sealed.frontDoors).toEqual([]);
	expect(sealed.locks).toEqual([]);
});

it("the migrate job runs as its own identity, not the backend's", () => {
	const d = deployment(false);
	const calls = moduleCalls(d);
	const job = calls.find((m) => m.mainType === "Microsoft.App/jobs");
	const backend = calls.find(
		(m) =>
			m.mainType === "Microsoft.App/containerApps" &&
			String(m.parameters.name).includes("backend"),
	);
	if (!job || !backend) throw new Error("no job or backend");
	const identityOf = (m: { parameters: Record<string, unknown> }) =>
		(
			m.parameters.managedIdentities as { userAssignedResourceIds: unknown[] }
		).userAssignedResourceIds.map(String);
	const jobIdentities = identityOf(job);
	expect(jobIdentities).toHaveLength(1);
	expect(jobIdentities[0]).toContain("migrate");
	expect(jobIdentities).not.toEqual(identityOf(backend));
});

/** One variable as each app is handed it. */
function appSetting(overrides: Record<string, unknown>, name: string) {
	return allResources(sampleDeployment(overrides) as Deployment)
		.filter((r) => r.type === "Microsoft.App/containerApps" && r.condition)
		.map(
			(app) =>
				(
					app.properties as {
						template: {
							containers: { env: { name: string; value?: string }[] }[];
						};
					}
				).template.containers[0].env.find((e) => e.name === name)?.value,
		);
}

it("sign-in is as asked in the demo and the identity provider's when hardened, on both apps", () => {
	const modes = (overrides: Record<string, unknown>) =>
		appSetting(overrides, "AUTH_MODE");
	expect(modes({})).toEqual(["local", "local"]);
	expect(modes({ authMode: "entra" })).toEqual(["entra", "entra"]);
	expect(modes({ hardened: true, authMode: "local" })).toEqual([
		"entra",
		"entra",
	]);
});

it("admission by role is as asked in the demo and always on when hardened, which the apps refuse to start without", () => {
	const required = (overrides: Record<string, unknown>) =>
		appSetting(overrides, "AUTH_REQUIRE_ROLE");
	expect(required({})).toEqual(["", ""]);
	expect(required({ authRequireRole: true })).toEqual(["1", "1"]);
	expect(required({ hardened: true, authRequireRole: false })).toEqual([
		"1",
		"1",
	]);
});

it("both apps are told which mode they run in", () => {
	for (const hardened of [false, true]) {
		const apps = allResources(deployment(hardened)).filter(
			(r) => r.type === "Microsoft.App/containerApps" && r.condition,
		);
		expect(apps).toHaveLength(2);
		for (const app of apps) {
			const env = (
				app.properties as {
					template: {
						containers: { env: { name: string; value?: string }[] }[];
					};
				}
			).template.containers[0].env;
			expect(env.find((e) => e.name === "HARDENED")?.value).toBe(
				String(hardened),
			);
		}
	}
});

// The Foundry memory store's extraction calls the account from outside the
// network, so the backend must know when the account's public access is off:
// the same switch that closes it, not the bundle.
it("the backend is told whether the network is private, from the one switch that closes the public listeners", () => {
	const told = (overrides: Record<string, unknown>) => {
		const d = sampleDeployment(overrides);
		if (!d) throw new Error("no template");
		const backend = allResources(d).find(
			(r) =>
				r.type === "Microsoft.App/containerApps" &&
				r.condition &&
				(r.tags as Record<string, string>)["azd-service-name"] === "backend",
		);
		if (!backend) throw new Error("no backend app");
		const { template } = backend.properties as {
			template: { containers: { env: { name: string; value?: string }[] }[] };
		};
		return template.containers[0]?.env.find(
			(e) => e.name === "PRIVATE_NETWORKING",
		)?.value;
	};
	expect(told({ hardened: false })).toBe("false");
	expect(told({ hardened: true })).toBe("true");
	expect(told({ hardened: true, privateNetworking: "false" })).toBe("false");
	expect(told({ hardened: false, privateNetworking: "true" })).toBe("true");
	expect(
		shape(deployment(true)).publicAccess[
			"Microsoft.CognitiveServices/accounts"
		],
	).toBe("Disabled");
});

it("hardened Storage is reached through a blob private endpoint alone, and denies the rest", () => {
	const groups = allResources(deployment(true))
		.filter(
			(r) => r.type === "Microsoft.Network/privateEndpoints" && r.condition,
		)
		.flatMap(
			(r) =>
				(
					r.properties as {
						privateLinkServiceConnections: {
							properties: { groupIds: string[] };
						}[];
					}
				).privateLinkServiceConnections[0]?.properties.groupIds ?? [],
		);
	expect(groups).toContain("blob");
	const account = (hardened: boolean) =>
		moduleCalls(deployment(hardened)).find(
			(m) => m.mainType === "Microsoft.Storage/storageAccounts",
		)?.parameters;
	expect(account(true)?.networkAcls).toMatchObject({ defaultAction: "Deny" });
	expect(account(false)?.networkAcls).toMatchObject({ defaultAction: "Allow" });
});

type Scale = { minReplicas: number; maxReplicas: number };

function replicas(overrides: Record<string, unknown>) {
	const d = sampleDeployment(overrides) as Deployment;
	const scaleOf = (service: string): Scale => {
		const app = allResources(d).find(
			(r) =>
				r.type === "Microsoft.App/containerApps" &&
				r.condition &&
				(r.tags as Record<string, string>)["azd-service-name"] === service,
		);
		if (!app) throw new Error(`no ${service} app`);
		const { minReplicas, maxReplicas } = (
			app.properties as { template: { scale: Scale } }
		).template.scale;
		return { minReplicas, maxReplicas };
	};
	return {
		backend: scaleOf("backend"),
		frontend: scaleOf("frontend"),
		search: moduleCalls(d).find(
			(m) => m.mainType === "Microsoft.Search/searchServices",
		)?.parameters.replicaCount,
	};
}

it("without zones each app and AI Search run one replica, or the floor the environment names", () => {
	expect(replicas({})).toEqual({
		backend: { minReplicas: 1, maxReplicas: 3 },
		frontend: { minReplicas: 1, maxReplicas: 3 },
		search: 1,
	});
	expect(
		replicas({
			backendMinReplicas: 4,
			frontendMinReplicas: 2,
			searchReplicas: 3,
		}),
	).toEqual({
		// A floor above the ceiling raises the ceiling with it.
		backend: { minReplicas: 4, maxReplicas: 4 },
		frontend: { minReplicas: 2, maxReplicas: 3 },
		search: 3,
	});
});

it("zone redundant, each app and AI Search run at least two replicas: one replica is in one zone", () => {
	for (const overrides of [
		{ hardened: true },
		{ privateNetworking: "true", zoneRedundant: "true" },
	])
		expect(replicas(overrides), JSON.stringify(overrides)).toEqual({
			backend: { minReplicas: 2, maxReplicas: 3 },
			frontend: { minReplicas: 2, maxReplicas: 3 },
			search: 2,
		});
	// A floor above two stands; hardened with the zones switched off is one again.
	expect(replicas({ hardened: true, searchReplicas: 3 }).search).toBe(3);
	expect(replicas({ hardened: true, backendMinReplicas: 3 }).backend).toEqual({
		minReplicas: 3,
		maxReplicas: 3,
	});
	expect(replicas({ hardened: true, zoneRedundant: "false" })).toEqual({
		backend: { minReplicas: 1, maxReplicas: 3 },
		frontend: { minReplicas: 1, maxReplicas: 3 },
		search: 1,
	});
});

it("more replicas than the basic Search tier runs are refused as the template is read, and a standard tier takes them", () => {
	const refused = (overrides: Record<string, unknown>) =>
		(sampleDeployment(overrides) as Deployment).resources
			.filter((r) => r.error)
			.map((r) => `${r.symbol}: ${r.error}`);
	expect(refused({ searchReplicas: 3 })).toEqual([]);
	const over = refused({ searchReplicas: 4 });
	expect(over.some((line) => line.startsWith("search: "))).toBe(true);
	expect(over.join("\n")).toContain(
		"SEARCH_REPLICAS is 4 and the basic AI Search tier runs at most 3",
	);
	expect(refused({ searchReplicas: 4, searchSku: "standard" })).toEqual([]);
	expect(replicas({ searchReplicas: 4, searchSku: "standard" }).search).toBe(4);
});

test("the replica floors are azd variables, so `azd env set` reaches them", () => {
	const file = readFileSync(join(INFRA, "main.parameters.json"), "utf8");
	for (const variable of [
		"BACKEND_MIN_REPLICAS",
		"FRONTEND_MIN_REPLICAS",
		"SEARCH_REPLICAS",
	])
		expect(file).toContain(`\${${variable}=1}`);
});
