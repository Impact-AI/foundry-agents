/**
 * The template compiles, and it has the shape azd expects: the three
 * parameters azd supplies, the resource group tagged with the environment,
 * each service's Container App tagged with its name and nothing else tagged
 * that way, and a parameter file that names every parameter without a
 * default. Skipped without a Bicep CLI; `what-if` needs a subscription and
 * is not run here (see arm.ts).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	allErrors,
	allResources,
	compiledMain,
	INFRA,
	moduleCalls,
	sampleDeployment,
	type Template,
} from "./arm";

const template = compiledMain();
const it = test.skipIf(template === null);

it("bicep build succeeds and the template is subscription-scoped", () => {
	const t = template as Template & { $schema: string };
	expect(t.$schema).toContain("subscriptionDeploymentTemplate");
});

it("declares the three parameters azd supplies", () => {
	const declared = Object.keys((template as Template).parameters ?? {});
	expect(declared).toEqual(
		expect.arrayContaining(["environmentName", "location", "principalId"]),
	);
});

it("tags the resource group with the environment name", () => {
	const d = sampleDeployment() as NonNullable<
		ReturnType<typeof sampleDeployment>
	>;
	const groups = allResources(d).filter(
		(r) => r.type === "Microsoft.Resources/resourceGroups" && r.condition,
	);
	expect(groups.map((g) => g.name)).toEqual(["rg-sample"]);
	expect(groups[0].tags).toEqual({ "azd-env-name": "sample" });
});

it("tags exactly one Container App per service, and never the job", () => {
	const d = sampleDeployment() as NonNullable<
		ReturnType<typeof sampleDeployment>
	>;
	const tagged = allResources(d)
		.filter(
			(r) =>
				r.condition &&
				(r.tags as Record<string, string> | null)?.["azd-service-name"],
		)
		.map((r) => ({
			type: r.type,
			service: (r.tags as Record<string, string>)["azd-service-name"],
		}));
	expect(tagged.sort((a, b) => a.service.localeCompare(b.service))).toEqual([
		{ type: "Microsoft.App/containerApps", service: "backend" },
		{ type: "Microsoft.App/containerApps", service: "frontend" },
	]);
});

// Every nested deployment at every depth, the verified modules' own
// included: an expression Azure would refuse is an error here. The sets are
// the modes and the switches that add or reshape a module.
const SHAPES: Record<string, unknown>[] = [
	{},
	{ hardened: true },
	{
		hardened: true,
		developerAccess: true,
		developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
	},
	{ hardened: true, agentEgress: "restricted" },
	{ hardened: true, privateTelemetry: "true" },
	{ privateNetworking: "true" },
	{ useFrontDoor: "true" },
	{ knowledgeBase: true },
	{ operatorPrincipalId: "99999999-8888-7777-6666-555555555555" },
	{ backendExists: true, frontendExists: true },
];
for (const shape of SHAPES) {
	it(`evaluates without error at every depth: ${JSON.stringify(shape)}`, () => {
		const d = sampleDeployment(shape) as NonNullable<
			ReturnType<typeof sampleDeployment>
		>;
		const resources = allResources(d);
		expect(resources.length).toBeGreaterThan(50);
		expect(allErrors(d)).toEqual([]);
	});
}

// Every module below the resource group's own lands in that one group, and a
// deployment there whose name is already running is refused (DeploymentActive):
// a wrapper's inner call named after the wrapper overwrites its own parent.
for (const hardened of [false, true]) {
	it(`names each deployment in the resource group once, hardened=${hardened}`, () => {
		const d = sampleDeployment({ hardened }) as NonNullable<
			ReturnType<typeof sampleDeployment>
		>;
		const names = allResources(d)
			.filter((r) => r.deployment && r.condition && r.path.length <= 1)
			.map((r) => r.name)
			.filter((name) => name !== "resource-group");
		const repeated = names.filter((n, i) => names.indexOf(n) !== i);
		expect(repeated).toEqual([]);
	});
}

// Azure refuses a network rule set on a Basic or Standard registry
// (NetworkRuleNotSupported); only Premium takes one, and the template's
// registry is never Premium.
for (const hardened of [false, true]) {
	it(`gives the registry no network rule set, hardened=${hardened}`, () => {
		const d = sampleDeployment({ hardened }) as NonNullable<
			ReturnType<typeof sampleDeployment>
		>;
		const registries = allResources(d).filter(
			(r) => r.condition && r.type === "Microsoft.ContainerRegistry/registries",
		);
		expect(registries).toHaveLength(1);
		const { properties } = registries[0] as unknown as {
			properties: { networkRuleSet?: unknown };
		};
		expect(properties.networkRuleSet ?? null).toBeNull();
	});
}

// A region that has the models' quota can refuse a new Search service
// (InsufficientResourcesAvailable); Search alone can move.
for (const [searchLocation, expected] of [
	["", "westeurope"],
	["northeurope", "northeurope"],
]) {
	it(`places AI Search in ${expected} when searchLocation is '${searchLocation}'`, () => {
		const d = sampleDeployment({ searchLocation }) as NonNullable<
			ReturnType<typeof sampleDeployment>
		>;
		const located = (type: string) =>
			moduleCalls(d)
				.filter((m) => m.mainType === type)
				.map((m) => m.parameters.location);
		expect(located("Microsoft.Search/searchServices")).toEqual([expected]);
		expect(located("Microsoft.CognitiveServices/accounts")).toEqual([
			"westeurope",
		]);
	});
}

// The job module types a container's cpu as a string where the app module
// takes a number; ARM refuses the other one at validation (InvalidTemplate).
it("gives each container's cpu the type its module declares", () => {
	const d = sampleDeployment() as NonNullable<
		ReturnType<typeof sampleDeployment>
	>;
	const wrong = moduleCalls(d).flatMap((m) => {
		const declared = (
			m.deployment.template as {
				definitions?: Record<
					string,
					{ properties?: { cpu?: { type?: string } } }
				>;
			}
		).definitions?.containerResourceType?.properties?.cpu?.type;
		const containers = (m.parameters.containers ?? []) as {
			name: string;
			resources: { cpu: unknown };
		}[];
		if (!declared) return [];
		return containers
			.filter((c) => typeof c.resources.cpu !== declared)
			.map((c) => `${c.name}: ${typeof c.resources.cpu}, declared ${declared}`);
	});
	expect(wrong).toEqual([]);
});

test("main.parameters.json covers every parameter without a default, with azd's variables", () => {
	const file = JSON.parse(
		readFileSync(join(INFRA, "main.parameters.json"), "utf8"),
	) as { parameters: Record<string, { value: unknown }> };
	expect(file.parameters.environmentName.value).toMatch(
		/^\$\{AZURE_ENV_NAME\}$/,
	);
	expect(file.parameters.location.value).toMatch(/^\$\{AZURE_LOCATION\}$/);
	expect(file.parameters.principalId.value).toMatch(
		/^\$\{AZURE_PRINCIPAL_ID\}$/,
	);
	if (!template) return;
	const required = Object.entries(template.parameters ?? {})
		.filter(([, p]) => !("defaultValue" in p) && !p.nullable)
		.map(([name]) => name);
	for (const name of required)
		expect(Object.keys(file.parameters)).toContain(name);
	for (const name of Object.keys(file.parameters))
		expect(Object.keys(template.parameters ?? {})).toContain(name);
});

// Two environments in one subscription provision side by side; a deployment
// at subscription scope named the same in both refuses the second.
it("every deployment at subscription scope is named for its environment", () => {
	const namesFor = (environmentName: string) => {
		const d = sampleDeployment({ environmentName }) as NonNullable<
			ReturnType<typeof sampleDeployment>
		>;
		return Object.entries(d.template.resources ?? {})
			.filter(
				([, r]) =>
					r.type === "Microsoft.Resources/deployments" &&
					r.resourceGroup === undefined,
			)
			.map(([symbol]) =>
				String(d.resources.find((r) => r.symbol === symbol)?.name),
			);
	};
	const one = namesFor("one");
	const two = namesFor("two");
	expect(one.length).toBeGreaterThan(0);
	for (const name of one) expect(two).not.toContain(name);
});

// The agent's state is Foundry's and Cosmos DB's: a relational database
// coming back, in either shape, is a design change, not an addition.
it("provisions no relational database in either shape, and no app is told of one", () => {
	for (const hardened of [false, true]) {
		const d = sampleDeployment({ hardened }) as NonNullable<
			ReturnType<typeof sampleDeployment>
		>;
		const types = allResources(d).map((r) => r.type.toLowerCase());
		expect(types.filter((t) => /postgres|mysql|sql\/servers/.test(t))).toEqual(
			[],
		);
		for (const app of allResources(d).filter(
			(r) =>
				r.type === "Microsoft.App/containerApps" ||
				r.type === "Microsoft.App/jobs",
		)) {
			const env = (
				app.properties as {
					template: { containers: { env: { name: string }[] }[] };
				}
			).template.containers.flatMap((c) => c.env.map((e) => e.name));
			expect(env.filter((name) => /^(PG|DATABASE_)/.test(name))).toEqual([]);
		}
	}
});
