/**
 * Cosmos DB, the database the app moves to: Entra only, serverless unless
 * zone redundancy is on, and then provisioned, zone-redundant, with the
 * app's database on one autoscaled budget (Foundry's `enterprise_memory`
 * needs 3 × 1000 RU/s of its own, which serverless or provisioned both
 * give it). The app's containers are declared here with the partition key
 * each one's reads are scoped by; the backend and the job may read and
 * write `app` and nothing else; the deploying principal reads every database
 * and writes `app`, where an operator publishes the persona. Hardened, it
 * is private and locked like every data service.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { repositoryRoot } from "../docs/markdown";
import {
	allResources,
	compiledMain,
	type Deployment,
	moduleCalls,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const COSMOS = "Microsoft.DocumentDB/databaseAccounts";

function deployment(overrides: Record<string, unknown> = {}): Deployment {
	const d = sampleDeployment(overrides);
	if (!d) throw new Error("no template");
	return d;
}

type Container = {
	name: string;
	paths: string[];
	indexingPolicy: {
		includedPaths: { path: string }[];
		excludedPaths: { path: string }[];
		compositeIndexes?: { path: string; order: string }[][];
	};
	defaultTtl?: number;
};

type Account = {
	capacityMode: string;
	zoneRedundant: boolean;
	enableBurstCapacity: boolean;
	disableLocalAuthentication: boolean;
	networkRestrictions: { publicNetworkAccess: string };
	sqlDatabases: {
		name: string;
		autoscaleSettingsMaxThroughput: number | null;
		containers: Container[];
	}[];
	sqlRoleAssignments: {
		principalId: unknown;
		roleDefinitionId: string;
		scope?: string;
	}[];
};

function account(overrides: Record<string, unknown> = {}): Account {
	const call = moduleCalls(deployment(overrides)).find(
		(m) => m.mainType === COSMOS,
	);
	if (!call) throw new Error("no Cosmos DB account");
	return call.parameters as unknown as Account;
}

for (const [overrides, zonal] of [
	[{}, false],
	[{ hardened: true }, true],
	[{ zoneRedundant: "true", privateNetworking: "true" }, true],
	[{ hardened: true, zoneRedundant: "false" }, false],
] as const) {
	it(`ZONE_REDUNDANT decides the throughput: ${zonal ? "provisioned and zone-redundant" : "serverless"}, ${JSON.stringify(overrides)}`, () => {
		const a = account(overrides);
		expect(a.capacityMode).toBe(zonal ? "Provisioned" : "Serverless");
		expect(a.zoneRedundant).toBe(zonal);
		// Serverless refuses burst capacity and any throughput setting.
		expect(a.enableBurstCapacity).toBe(zonal);
		expect(a.sqlDatabases[0]?.autoscaleSettingsMaxThroughput).toBe(
			zonal ? 1000 : null,
		);
	});
}

it("Entra only, in both modes", () => {
	for (const hardened of [false, true])
		expect(account({ hardened }).disableLocalAuthentication).toBe(true);
});

it("the app's database holds the six containers, each partitioned by what its reads are scoped to", () => {
	const [app, ...others] = account().sqlDatabases;
	expect(others).toEqual([]);
	expect(app?.name).toBe("app");
	expect(
		Object.fromEntries(app?.containers.map((c) => [c.name, c.paths]) ?? []),
	).toEqual({
		accounts: ["/id"],
		threads: ["/resourceId"],
		messages: ["/resourceId"],
		memory: ["/resourceId"],
		threadIds: ["/id"],
		prompts: ["/key"],
	});
});

it("every container the backend's stores declare is in the template, partitioned and composite-indexed as they address it", async () => {
	const { cosmosContainers } = (await import(
		join(repositoryRoot(), "apps", "backend", "src", "containers.ts")
	)) as {
		cosmosContainers: {
			name: string;
			partitionKey: string;
			compositeIndexes?: { path: string; order: string }[][];
		}[];
	};
	expect(cosmosContainers.length).toBeGreaterThan(0);
	const declared = new Map(
		account().sqlDatabases[0]?.containers.map((c) => [c.name, c]) ?? [],
	);
	for (const { name, partitionKey, compositeIndexes } of cosmosContainers) {
		expect(declared.get(name)?.paths, name).toEqual([partitionKey]);
		for (const index of compositeIndexes ?? [])
			expect(
				declared.get(name)?.indexingPolicy.compositeIndexes,
				name,
			).toContainEqual(index);
	}
});

it("a person's free text, a conversation's words and what is remembered are never indexed; paging newest first has its composite index; claims are read by id only", () => {
	const containers = Object.fromEntries(
		account().sqlDatabases[0]?.containers.map((c) => [c.name, c]) ?? [],
	);
	const excluded = (name: string) =>
		containers[name]?.indexingPolicy.excludedPaths.map((p) => p.path);
	expect(excluded("accounts")).toEqual(
		expect.arrayContaining(["/about/?", "/preferences/?"]),
	);
	// The history is read by thread in order: those two fields, and no word of it.
	expect(containers.messages?.indexingPolicy).toEqual({
		includedPaths: [{ path: "/threadId/?" }, { path: "/seq/?" }],
		excludedPaths: [{ path: "/*" }],
	});
	expect(excluded("prompts")).toEqual(expect.arrayContaining(["/prompt/?"]));
	expect(containers.threads?.indexingPolicy.compositeIndexes).toEqual([
		[
			{ path: "/updatedAt", order: "descending" },
			{ path: "/id", order: "descending" },
		],
	]);
	for (const name of ["memory", "threadIds"])
		expect(containers[name]?.indexingPolicy, name).toEqual({
			includedPaths: [],
			excludedPaths: [{ path: "/*" }],
		});
});

it("the backend and the job read and write the app's database and nothing else; the deploying principal reads everything and writes the app's database", () => {
	const roles = account().sqlRoleAssignments.map((r) => ({
		who:
			/outputs\.(backend|migrate)\./.exec(String(r.principalId))?.[1] ??
			r.principalId,
		role: r.roleDefinitionId,
		scope: r.scope ?? "the account",
	}));
	const contributor = "00000000-0000-0000-0000-000000000002";
	const reader = "00000000-0000-0000-0000-000000000001";
	expect(roles).toEqual([
		{
			who: "backend",
			role: contributor,
			scope: expect.stringMatching(/\/dbs\/app$/),
		},
		{
			who: "migrate",
			role: contributor,
			scope: expect.stringMatching(/\/dbs\/app$/),
		},
		{
			who: "11111111-2222-3333-4444-555555555555",
			role: contributor,
			scope: expect.stringMatching(/\/dbs\/app$/),
		},
		{
			who: "11111111-2222-3333-4444-555555555555",
			role: reader,
			scope: "the account",
		},
	]);
});

it("hardened: a Sql private endpoint in the data subnet, the public listener off, and a lock; the demo has none of them", () => {
	const endpoints = (hardened: boolean) =>
		allResources(deployment({ hardened }))
			.filter(
				(r) =>
					r.condition &&
					r.type === "Microsoft.Network/privateEndpoints" &&
					r.path.some((p) => p === "cosmos"),
			)
			.map(
				(r) =>
					(
						r.properties as {
							privateLinkServiceConnections: {
								properties: { groupIds: string[] };
							}[];
						}
					).privateLinkServiceConnections[0]?.properties.groupIds,
			);
	expect(endpoints(true)).toEqual([["Sql"]]);
	expect(endpoints(false)).toEqual([]);
	expect(
		account({ hardened: true }).networkRestrictions.publicNetworkAccess,
	).toBe("Disabled");
	expect(account().networkRestrictions.publicNetworkAccess).toBe("Enabled");
});

it("accounts alone has time to live on, with no default: a document expires only when it names its own ttl", () => {
	const containers = account().sqlDatabases[0]?.containers ?? [];
	expect(
		Object.fromEntries(containers.map((c) => [c.name, c.defaultTtl])),
	).toEqual({
		accounts: -1,
		threads: undefined,
		messages: undefined,
		memory: undefined,
		threadIds: undefined,
		prompts: undefined,
	});
});
