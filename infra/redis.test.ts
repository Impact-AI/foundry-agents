/**
 * Redis is Azure Managed Redis: one instance and its one database, Entra
 * only, reached over TLS on the database's port. The database keeps every key
 * on one shard, because the ledger's and the queues' scripts name keys a
 * sharded policy would put in different slots.
 */
import { expect, test } from "bun:test";
import {
	allResources,
	compiledMain,
	type Deployment,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const JUMP = {
	hardened: true,
	developerAccess: true,
	developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
};

function deployment(overrides: Record<string, unknown> = {}): Deployment {
	const d = sampleDeployment(overrides);
	if (!d) throw new Error("no template");
	return d;
}

function live(d: Deployment, type: string) {
	return allResources(d).filter((r) => r.condition && r.type === type);
}

/** The identities the database admits, read from the assignments the compiled module makes, not from what it was handed. */
function admitted(d: Deployment) {
	return live(
		d,
		"Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments",
	).map((r) => {
		const p = r.properties as {
			accessPolicyName: string;
			user: { objectId: unknown };
		};
		return {
			name: String(r.name).split("/").pop() ?? "",
			policy: p.accessPolicyName,
			who: JSON.stringify(p.user.objectId),
			error: r.error,
		};
	});
}

it("the demo: one Managed Redis instance at the smallest size, unreplicated, its public listener on", () => {
	const d = deployment();
	expect(live(d, "Microsoft.Cache/redis")).toEqual([]);
	const [instance, ...others] = live(d, "Microsoft.Cache/redisEnterprise");
	expect(others).toEqual([]);
	expect(
		d.resources.find((r) => r.symbol === "redis")?.deployment?.parameters.sku,
	).toBe("Balanced_B0");
	expect(instance?.properties).toMatchObject({
		highAvailability: "Disabled",
		minimumTlsVersion: "1.2",
		publicNetworkAccess: "Enabled",
	});
});

it("zone redundant: replicated, which the service spreads over zones, and closed to the internet behind its own DNS zone", () => {
	const d = deployment({ hardened: true });
	const [instance] = live(d, "Microsoft.Cache/redisEnterprise");
	expect(instance?.properties).toMatchObject({
		highAvailability: "Enabled",
		publicNetworkAccess: "Disabled",
	});
	const zones = live(d, "Microsoft.Network/privateDnsZones").map((z) =>
		String(z.name),
	);
	expect(zones).toContain("privatelink.redis.azure.net");
	expect(zones).not.toContain("privatelink.redis.cache.windows.net");
});

for (const overrides of [{}, { hardened: true }]) {
	it(`the database is unsharded, TLS only, on the service's port, and evicts only keys with a TTL: ${JSON.stringify(overrides)}`, () => {
		const [database, ...others] = live(
			deployment(overrides),
			"Microsoft.Cache/redisEnterprise/databases",
		);
		expect(others).toEqual([]);
		expect(database?.properties).toMatchObject({
			clusteringPolicy: "NoCluster",
			clientProtocol: "Encrypted",
			evictionPolicy: "VolatileLRU",
			port: 10000,
		});
	});

	it(`access keys are off and the backend is the one identity admitted, under a name of letters and digits: ${JSON.stringify(overrides)}`, () => {
		const d = deployment(overrides);
		// The database takes the setting once the instance's SKU is read back, so it is read where the module hands it to the database's own deployment.
		const handed = allResources(d).find(
			(r) =>
				r.condition &&
				r.deployment?.resources.some(
					(inner) => inner.type === "Microsoft.Cache/redisEnterprise/databases",
				),
		);
		expect(handed?.deployment?.parameters.accessKeysAuthentication).toBe(
			"Disabled",
		);
		const [backend, ...others] = admitted(d);
		expect(others).toEqual([]);
		expect(backend?.error).toBeUndefined();
		expect(backend?.policy).toBe("default");
		expect(backend?.who).toContain("backend");
		// The backend's object id is the deployment's to answer; its name is that id without hyphens.
		expect(backend?.name).not.toBe("");
		expect(backend?.name).not.toContain("null");
	});
}

it("with the jump host, the operator is admitted beside the backend, each assignment named by its object id without the hyphens", () => {
	const names = admitted(deployment(JUMP)).map((a) => a.name);
	expect(names).toHaveLength(2);
	expect(names[1]).toBe("11111111222233334444555555555555");
	// What the service takes for an assignment's name.
	expect(names[1]).toMatch(/^[A-Za-z0-9]{1,60}$/);
});

it("an operator that is a group is not admitted: the service signs in an identity, never a group's members", () => {
	const d = deployment({
		...JUMP,
		operatorPrincipalId: "99999999-8888-7777-6666-555555555555",
		operatorPrincipalType: "Group",
	});
	expect(admitted(d)).toHaveLength(1);
	expect(
		admitted(
			deployment({
				...JUMP,
				operatorPrincipalId: "99999999-8888-7777-6666-555555555555",
			}),
		).map((a) => a.name),
	).toContain("99999999888877776666555555555555");
});

it("the database sends its own logs to the workspace, beside the instance's metrics", () => {
	const d = deployment();
	const module = d.resources.find((r) => r.symbol === "redis")?.deployment;
	const settings = allResources(module as Deployment).filter(
		(r) => r.condition && r.type === "Microsoft.Insights/diagnosticSettings",
	);
	const onDatabase = settings.filter((r) =>
		JSON.stringify(r.scope).includes("redisEnterprise/databases"),
	);
	expect(onDatabase).toHaveLength(1);
	expect(settings.length).toBe(2);
	// No category is named, so the module sends every log the database has.
	expect(
		(onDatabase[0]?.properties as { workspaceId: unknown } | undefined)
			?.workspaceId,
	).toBeTruthy();
	const handed = module?.resources.find((r) => r.symbol === "cache")?.deployment
		?.parameters.database as {
		diagnosticSettings?: Record<string, unknown>[];
	};
	expect(handed.diagnosticSettings).toHaveLength(1);
	expect(Object.keys(handed.diagnosticSettings?.[0] ?? {})).toEqual([
		"workspaceResourceId",
	]);
});

it("the backend's URL takes the host and the port from the instance, and the environment is told both", () => {
	const d = deployment(JUMP);
	const backend = allResources(d).find(
		(r) =>
			r.condition &&
			r.type === "Microsoft.App/containerApps" &&
			String(r.name).includes("backend"),
	);
	expect(JSON.stringify(backend?.properties)).toContain(
		'"name":"REDIS_URL","value":{"path":"reference(redis).outputs.url.value"}',
	);
	expect(d.outputs.REDIS_HOST).toEqual({
		path: "reference(redis).outputs.hostName.value",
	});
	expect(d.outputs.REDIS_PORT).toEqual({
		path: "reference(redis).outputs.port.value",
	});
});
