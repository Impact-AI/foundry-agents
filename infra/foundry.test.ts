/**
 * The Foundry account and the Agent Service's standard setup, as the compiled
 * template makes them. The account is the Azure OpenAI account upgraded in
 * place: same name, now AIServices with a system identity and projects. One
 * guardrail, DefaultV2 plus indirect-attack detection, is on every
 * deployment. The project holds its connections; the capability hosts bind
 * it to them after the project's identity has its roles on the three stores,
 * and the narrower roles follow them. Hardened injects the agent into a
 * subnet of its own, which creates the account's capability host; the demo
 * makes that host itself. People who sign in hold no Azure role, and no key
 * leaves the resource that issued it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	allResources,
	compiledMain,
	type Deployment,
	moduleCalls,
	parameterFile,
	type Resource,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const ACCOUNT = "Microsoft.CognitiveServices/accounts";
const DEPLOYMENT = "Microsoft.CognitiveServices/accounts/deployments";
const RAI = "Microsoft.CognitiveServices/accounts/raiPolicies";
const PROJECT = "Microsoft.CognitiveServices/accounts/projects";
const CONNECTION = "Microsoft.CognitiveServices/accounts/projects/connections";
const ACCOUNT_HOST = "Microsoft.CognitiveServices/accounts/capabilityHosts";
const PROJECT_HOST =
	"Microsoft.CognitiveServices/accounts/projects/capabilityHosts";
const ROLE = "Microsoft.Authorization/roleAssignments";
const COSMOS_ROLE = "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments";

/** Built-in roles by id, so a failure reads as a name. */
const ROLES: Record<string, string> = {
	"53ca6127-db72-4b80-b1b0-d745d6d5456d": "Foundry User",
	"a97b65f3-24c7-4388-baec-2e87135dc908": "Cognitive Services User",
	"5e0bd9bd-7b93-4f28-af87-19fc36ad61bd": "Cognitive Services OpenAI User",
	"230815da-be43-4aae-9cb4-875f7bd000aa": "Cosmos DB Operator",
	"ba92f5b4-2d11-453d-a403-e96b0029c9fe": "Storage Blob Data Contributor",
	"b7e6dc6d-f1e8-4753-8033-0f276bb0955b": "Storage Blob Data Owner",
	"2a2b9908-6ea1-4ae2-8e65-a410df84e7d1": "Storage Blob Data Reader",
	"8ebe5a00-799e-43f5-93ac-243d3dce84a7": "Search Index Data Contributor",
	"7ca78c08-252a-4471-8644-bb5ff32d4ba0": "Search Service Contributor",
	"00000000-0000-0000-0000-000000000001": "Cosmos DB Built-in Data Reader",
	"00000000-0000-0000-0000-000000000002": "Cosmos DB Built-in Data Contributor",
};

const DEPLOYER = "11111111-2222-3333-4444-555555555555";

function deployment(overrides: Record<string, unknown> = {}): Deployment {
	const d = sampleDeployment(overrides);
	if (!d) throw new Error("no template");
	return d;
}

const live = (d: Deployment) => allResources(d).filter((r) => r.condition);
const ofType = (d: Deployment, type: string) =>
	live(d).filter((r) => r.type === type);
const props = <T>(r: Resource | undefined) => r?.properties as T;

/** One of main.bicep's own modules, instantiated. */
function nested(d: Deployment, symbol: string): Deployment {
	const found = d.resources.find((r) => r.symbol === symbol)?.deployment;
	if (!found) throw new Error(`no ${symbol} deployment`);
	return found;
}

/** Who an assignment is for: an identity the template makes, by name, or the deploying principal. */
function holder(principalId: unknown): string {
	const id = String(principalId);
	if (id === DEPLOYER) return "deployer";
	const made = /outputs\.(backend|frontend|migrate)\.value\.principalId/.exec(
		id,
	);
	if (made) return made[1] as string;
	if (id.includes("reference(search).outputs.principalId")) return "search";
	if (id.includes("reference(foundry).outputs.principalId")) return "project";
	return `unknown: ${id}`;
}

/** Every role assignment, ARM's and Cosmos DB's own, as holder, role name and where. */
function assignments(d: Deployment) {
	return live(d)
		.filter((r) => r.type === ROLE || r.type === COSMOS_ROLE)
		.map((r) => {
			const p = props<{
				principalId: unknown;
				principalType?: string;
				roleDefinitionId: string;
				scope?: string;
			}>(r);
			const id = p.roleDefinitionId.split("/").pop() as string;
			return {
				holder: holder(p.principalId),
				principalType: p.principalType,
				role: ROLES[id] ?? id,
				/** Cosmos DB's data-plane scope, else the resource ARM's is on. */
				on: String(p.scope ?? r.scope ?? ""),
				module: r.path.join("/"),
			};
		});
}

const rolesOf = (d: Deployment, who: string) =>
	assignments(d)
		.filter((a) => a.holder === who)
		.map((a) => a.role)
		.sort();

for (const hardened of [false, true]) {
	it(`the account is the Azure OpenAI account upgraded in place: same name, AIServices, projects, its own identity, keyless, hardened=${hardened}`, () => {
		const call = moduleCalls(deployment({ hardened })).find(
			(m) => m.mainType === ACCOUNT,
		);
		const p = call?.parameters as Record<string, unknown>;
		expect(String(p.name)).toStartWith("oai-");
		expect(p.customSubDomainName).toBe(p.name);
		expect(p).toMatchObject({
			kind: "AIServices",
			allowProjectManagement: true,
			managedIdentities: { systemAssigned: true },
			disableLocalAuth: true,
			restrictOutboundNetworkAccess: false,
		});
	});
}

function guardedDeployments(overrides: Record<string, unknown>) {
	const d = deployment(overrides);
	const policies = ofType(d, RAI);
	expect(policies).toHaveLength(1);
	const name = String(policies[0]?.name).split("/").pop();
	const deployments = ofType(d, DEPLOYMENT);
	for (const each of deployments)
		expect(
			props<{ raiPolicyName: string }>(each).raiPolicyName,
			String(each.name),
		).toBe(name as string);
	return deployments;
}

it("every deployment carries the one guardrail, the realtime model's included: four in all", () => {
	const file = parameterFile({}) as {
		models: { realtime: { name: string; model: string; version: string } };
	};
	const { realtime } = file.models;
	const deployments = guardedDeployments({});
	expect(deployments).toHaveLength(4);
	const made = deployments.find((d) =>
		String(d.name).endsWith(`/${realtime.name}`),
	);
	expect(
		props<{ model: { name: string; version: string } }>(made).model,
	).toMatchObject({ name: realtime.model, version: realtime.version });
});

it("without the realtime model the voice has no deployment: three in all", () => {
	const file = parameterFile({}) as { models: Record<string, unknown> };
	// Explicitly null is the same as absent: the loop makes one per role that is set.
	expect(
		guardedDeployments({ models: { ...file.models, realtime: null } }),
	).toHaveLength(3);
	const { realtime: _, ...rest } = file.models;
	expect(guardedDeployments({ models: rest })).toHaveLength(3);
});

it("the deployments loop over every role of `models`, so a role added to the type is a deployment", () => {
	const source = readFileSync(
		join(import.meta.dir, "modules", "models.bicep"),
		"utf8",
	);
	expect(source).toContain(
		"for role in filter(items(models), role => role.value != null)",
	);
});

it("the guardrail is DefaultV2 with indirect attacks blocked, and keeps every default filter on", () => {
	const policy = props<{
		basePolicyName: string;
		contentFilters: {
			name: string;
			source: string;
			enabled: boolean;
			blocking: boolean;
			severityThreshold?: string;
		}[];
	}>(ofType(deployment(), RAI)[0]);
	expect(policy.basePolicyName).toBe("Microsoft.DefaultV2");
	const filter = (name: string, source: string) =>
		policy.contentFilters.find((f) => f.name === name && f.source === source);
	expect(filter("Indirect Attack", "Prompt")).toMatchObject({
		enabled: true,
		blocking: true,
	});
	expect(filter("Jailbreak", "Prompt")).toMatchObject({
		enabled: true,
		blocking: true,
	});
	for (const harm of ["Hate", "Sexual", "Violence", "Selfharm"])
		for (const source of ["Prompt", "Completion"])
			expect(filter(harm, source), `${harm} ${source}`).toMatchObject({
				enabled: true,
				blocking: true,
				severityThreshold: "Medium",
			});
	expect(policy.contentFilters.every((f) => f.enabled && f.blocking)).toBe(
		true,
	);
});

it("agent versions name the guardrail by its resource id, which the service requires", () => {
	expect(
		String(nested(deployment(), "modelAccount").outputs.guardrail),
	).toMatch(/raiPolicies\/.+\/default-indirect$/);
});

it("the project has its own identity and the four connections, the standard setup's three on Entra", () => {
	const d = deployment();
	const project = ofType(d, PROJECT);
	expect(project).toHaveLength(1);
	expect((project[0] as unknown as { name: string }).name).toEndWith("/agent");
	const connections = Object.fromEntries(
		ofType(d, CONNECTION).map((c) => {
			const p = props<{
				category: string;
				authType: string;
				metadata: { ResourceId?: string };
			}>(c);
			return [p.category, { ...p, name: String(c.name).split("/").pop() }];
		}),
	);
	// No connection to Application Insights unless the deployment asks for the service's traces.
	expect(Object.keys(connections).sort()).toEqual([
		"AzureStorageAccount",
		"CognitiveSearch",
		"CosmosDB",
	]);
	for (const category of [
		"CosmosDB",
		"AzureStorageAccount",
		"CognitiveSearch",
	]) {
		expect(connections[category]?.authType, category).toBe("AAD");
		expect(connections[category]?.metadata.ResourceId, category).toBeTruthy();
	}
});

// The service conflicts on a project's connections written in parallel, so
// they form one chain, each waiting for the one before it.
it("the Agent Service's traces are asked for: the project is connected to Application Insights only with agentTracing", () => {
	const insights = (overrides: Record<string, unknown>) =>
		ofType(deployment(overrides), CONNECTION).filter(
			(c) => props<{ category: string }>(c).category === "AppInsights",
		);
	expect(insights({})).toEqual([]);
	expect(insights({ agentTracing: false })).toEqual([]);
	expect(insights({ hardened: true })).toEqual([]);
	const asked = insights({ agentTracing: true });
	expect(asked).toHaveLength(1);
	expect(String(asked[0]?.name)).toEndWith("/insights");
});

it("the project's connections are made one at a time, each after the one before it", () => {
	const foundry = nested(deployment({ agentTracing: true }), "foundry");
	const chain = ["cosmos", "storage", "search", "insights"].map((name) => {
		const found = foundry.resources.find(
			(r) => r.type === CONNECTION && String(r.name).endsWith(`/${name}`),
		);
		if (!found) throw new Error(`no ${name} connection`);
		return found;
	});
	const symbols = chain.map((c) => c.symbol);
	expect(chain[0]?.dependsOn.filter((s) => symbols.includes(s))).toEqual([]);
	for (let i = 1; i < chain.length; i++)
		expect(chain[i]?.dependsOn, symbols[i]).toContain(symbols[i - 1] as string);
});

it("web search is the service's own tool: no Bing resource, and no resource reads a key with list*()", () => {
	const d = deployment();
	expect(live(d).filter((r) => r.type.startsWith("Microsoft.Bing/"))).toEqual(
		[],
	);
	const holdingKeys = live(d)
		.filter((r) => /"path":"list\w+\(/.test(JSON.stringify(r.properties)))
		.map((r) => r.type);
	expect(holdingKeys).toEqual([]);
});

it("no key crosses a module boundary or leaves as an output, and no new secret is a parameter", () => {
	for (const hardened of [false, true]) {
		const d = deployment({ hardened });
		const handed = live(d)
			.filter((r) => r.deployment)
			.filter((r) => /"path":"list\w+\(/.test(JSON.stringify(r.properties)))
			.map((r) => r.deployment?.name);
		expect(handed).toEqual([]);
	}
	const template = compiledMain();
	const outputs = Object.entries(template?.outputs ?? {})
		.filter(([, o]) => /list\w*\(|secure/i.test(JSON.stringify(o)))
		.map(([name]) => name);
	expect(outputs).toEqual([]);
	const secure = Object.entries(template?.parameters ?? {})
		.filter(([, p]) => /^secure/i.test(p.type))
		.map(([name]) => name)
		.sort();
	expect(secure).toEqual(["authSecret", "entraClientSecret"]);
});

for (const [overrides, injected] of [
	[{ hardened: false }, false],
	[{ hardened: true }, true],
	[{ hardened: true, privateNetworking: "false" }, false],
	[{ hardened: false, privateNetworking: "true" }, true],
] as const) {
	it(`the agent is injected into its own subnet exactly when the network exists, ${JSON.stringify(overrides)}`, () => {
		const d = deployment(overrides);
		const account = moduleCalls(d).find((m) => m.mainType === ACCOUNT)
			?.parameters as { networkInjections: unknown };
		const subnets = ofType(d, "Microsoft.Network/virtualNetworks/subnets");
		const agent = subnets.find((s) => String(s.name).endsWith("/agent"));
		// Injection makes the account's capability host; without it the template does.
		const accountHosts = ofType(d, ACCOUNT_HOST);
		if (injected) {
			expect(account.networkInjections).toMatchObject({ scenario: "agent" });
			expect(
				String(
					(account.networkInjections as { subnetResourceId: unknown })
						.subnetResourceId,
				),
			).toContain("agentSubnetId");
			expect(
				props<{
					addressPrefix: string;
					delegations: { properties: { serviceName: string } }[];
				}>(agent),
			).toMatchObject({
				addressPrefix: "10.0.4.0/24",
				delegations: [
					{ properties: { serviceName: "Microsoft.App/environments" } },
				],
			});
			expect(accountHosts).toEqual([]);
		} else {
			expect(account.networkInjections).toBeNull();
			expect(agent).toBeUndefined();
			expect(accountHosts).toHaveLength(1);
		}
		expect(ofType(d, PROJECT_HOST)).toHaveLength(1);
		for (const host of [...accountHosts, ...ofType(d, PROJECT_HOST)])
			expect(String(host.name).split("/").at(-1)).toMatch(/^[-\w]+$/);
	});
}

it("the project's capability host keeps threads in Cosmos DB, files in Storage and vectors in AI Search", () => {
	const d = deployment();
	const foundry = nested(d, "foundry");
	const named = foundry.outputs.connections as Record<string, string>;
	const category = (name: string) =>
		props<{ category: string }>(
			ofType(d, CONNECTION).find((c) => String(c.name).endsWith(`/${name}`)),
		).category;
	expect({
		threads: category(named.threads as string),
		files: category(named.files as string),
		vectors: category(named.vectors as string),
	}).toEqual({
		threads: "CosmosDB",
		files: "AzureStorageAccount",
		vectors: "CognitiveSearch",
	});
	const host = props<Record<string, unknown[]>>(ofType(d, PROJECT_HOST)[0]);
	expect(host.threadStorageConnections?.map(String)).toEqual([
		"<reference(foundry).outputs.connections.value.threads>",
	]);
	expect(host.storageConnections?.map(String)).toEqual([
		"<reference(foundry).outputs.connections.value.files>",
	]);
	expect(host.vectorStoreConnections?.map(String)).toEqual([
		"<reference(foundry).outputs.connections.value.vectors>",
	]);
});

for (const hardened of [false, true]) {
	it(`the project's identity has its roles on the stores before the capability host, and the narrower ones after it, hardened=${hardened}`, () => {
		const d = deployment({ hardened });
		const service = nested(d, "agentService");
		const bySymbol = new Map(service.resources.map((r) => [r.symbol, r]));
		const host = service.resources.find((r) => r.type === PROJECT_HOST);
		const before = (host?.dependsOn ?? [])
			.map((s) => bySymbol.get(s))
			.filter((r) => r?.type === ROLE);
		const roleOf = (r: Resource | undefined) =>
			ROLES[
				props<{ roleDefinitionId: string }>(r)
					.roleDefinitionId.split("/")
					.pop() as string
			];
		// The search roles are one copy loop: one symbol, two assignments.
		const searchRoles = service.resources
			.filter((r) => r.symbol === "searchRoles")
			.map(roleOf);
		expect(
			[
				...before.filter((r) => r?.symbol !== "searchRoles").map(roleOf),
				...(before.some((r) => r?.symbol === "searchRoles") ? searchRoles : []),
			].sort(),
		).toEqual(
			[
				"Cosmos DB Operator",
				"Search Index Data Contributor",
				"Search Service Contributor",
				"Storage Blob Data Contributor",
			].sort(),
		);
		const after = service.resources.filter((r) =>
			r.dependsOn.includes(host?.symbol as string),
		);
		expect(after.map((r) => r.type).sort()).toEqual([COSMOS_ROLE, ROLE].sort());
		const threads = props<{ scope: string; roleDefinitionId: string }>(
			after.find((r) => r.type === COSMOS_ROLE),
		);
		expect(threads.scope).toEndWith("/dbs/enterprise_memory");
		expect(threads.roleDefinitionId).toEndWith(
			"/00000000-0000-0000-0000-000000000002",
		);
		const files = props<{ roleDefinitionId: string; condition: string }>(
			after.find((r) => r.type === ROLE),
		);
		expect(roleOf(after.find((r) => r.type === ROLE))).toBe(
			"Storage Blob Data Owner",
		);
		expect(files.condition).toContain(
			"StringStartsWithIgnoreCase '<reference(foundry).outputs.workspaceId.value>'",
		);
		expect(files.condition).toContain("StringLikeIgnoreCase '*-azureml-agent'");
		expect(files.condition).not.toContain("{{");
	});
}

it("each identity holds the design's roles for the new resources", () => {
	const d = deployment();
	expect(rolesOf(d, "project")).toEqual(
		[
			"Cognitive Services OpenAI User",
			"Cosmos DB Built-in Data Contributor",
			"Cosmos DB Operator",
			"Search Index Data Contributor",
			"Search Service Contributor",
			"Storage Blob Data Contributor",
			"Storage Blob Data Owner",
		].sort(),
	);
	expect(rolesOf(d, "search")).toEqual(
		["Cognitive Services User", "Storage Blob Data Reader"].sort(),
	);
	const onProject = (who: string) =>
		assignments(d)
			.filter((a) => a.holder === who && a.role === "Foundry User")
			.map((a) => a.on);
	for (const who of ["backend", "migrate", "deployer"])
		expect(onProject(who), who).toEqual([
			expect.stringContaining("Microsoft.CognitiveServices/accounts/projects"),
		]);
	const onAccount = (who: string) =>
		assignments(d)
			.filter((a) => a.holder === who && a.module.startsWith("models/"))
			.map((a) => a.role)
			.sort();
	expect(onAccount("backend")).toEqual(
		["Cognitive Services OpenAI User", "Cognitive Services User"].sort(),
	);
	expect(onAccount("migrate")).toEqual(
		["Cognitive Services OpenAI User", "Cognitive Services User"].sort(),
	);
});

it("people who sign in hold no Azure role: every assignment is to an identity the template makes or to whoever runs azd up", () => {
	for (const overrides of [
		{},
		{ hardened: true },
		{
			hardened: true,
			developerAccess: true,
			developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
		},
	]) {
		const all = assignments(deployment(overrides));
		expect(all.length).toBeGreaterThan(0);
		expect(all.filter((a) => a.holder.startsWith("unknown"))).toEqual([]);
		expect(all.filter((a) => a.principalType === "Group")).toEqual([]);
	}
});

it("the project's endpoint is an output for the steps that follow, and nothing names a key", () => {
	const outputs = compiledMain()?.outputs ?? {};
	expect(Object.keys(outputs)).toEqual(
		expect.arrayContaining(["FOUNDRY_PROJECT_ENDPOINT", "COSMOS_ENDPOINT"]),
	);
	expect(nested(deployment(), "foundry").outputs.endpoint).toBe(
		"https://<reference(modelAccount).outputs.name.value>.services.ai.azure.com/api/projects/agent",
	);
});

it("no project connection reaches a knowledge base: the backend asks the base itself, with or without the planning model", () => {
	for (const overrides of [{}, { knowledgeBase: true }])
		expect(
			ofType(deployment(overrides), CONNECTION)
				.map((c) => props<{ category: string }>(c).category)
				.filter((category) => category === "RemoteTool"),
		).toEqual([]);
});
