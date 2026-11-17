/**
 * Azure Policy, in Audit, at the resource group: built-in definitions only,
 * following the Foundry baseline. Local authentication off is audited in both
 * modes, because both turn it off; public network access off only with
 * private networking, because the demo's endpoints are public by design.
 * Nothing is ever denied. POLICY_AUDIT=false assigns nothing.
 */
import { expect, test } from "bun:test";
import {
	allResources,
	compiledMain,
	type Deployment,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const ASSIGNMENT = "Microsoft.Authorization/policyAssignments";

/** Built-in definitions by id, so a failure reads as a name. */
const LOCAL_AUTH: Record<string, string> = {
	"71ef260a-8f18-47b7-abcb-62d0673d94dc":
		"Azure AI Services resources should have key access disabled",
	"5450f5bd-9c72-4390-a9c4-a7aba4edfdd2":
		"Cosmos DB accounts should have local authentication disabled",
	"6300012e-e9a4-4649-b41f-a85f5c43be91":
		"Azure AI Search services should have local authentication disabled",
	"8c6a50c6-9ffd-4ae7-986f-5fa6111f9a54":
		"Storage accounts should prevent shared key access",
};
const NETWORK: Record<string, string> = {
	"037eea7a-bd0a-46c5-9a66-03aea78705d3":
		"Azure AI Services resources should restrict network access",
	"797b37f7-06b8-444c-b1ad-fc62867f335a":
		"Azure Cosmos DB should disable public network access",
	"ee980b6d-0eca-4501-8d54-f6290fd512c3":
		"Azure AI Search services should disable public network access",
	"b2982f36-99f2-4db5-8eff-283140c09693":
		"Storage accounts should disable public network access",
};

type Assignment = {
	policyDefinitionId: string;
	enforcementMode: string;
	parameters: { effect: { value: string } };
};

function assignments(overrides: Record<string, unknown>): Assignment[] {
	const d: Deployment | null = sampleDeployment(overrides);
	if (!d) throw new Error("no template");
	return allResources(d)
		.filter((r) => r.type === ASSIGNMENT && r.condition)
		.map((r) => r.properties as Assignment);
}

const named = (list: Assignment[]) =>
	list
		.map((a) => {
			const id = a.policyDefinitionId.split("/").pop() as string;
			expect(a.policyDefinitionId).toContain(
				"Microsoft.Authorization/policyDefinitions",
			);
			return LOCAL_AUTH[id] ?? NETWORK[id] ?? `unknown ${id}`;
		})
		.sort();

it("the demo audits local authentication on the four services, and nothing about their network", () => {
	expect(named(assignments({ hardened: false }))).toEqual(
		Object.values(LOCAL_AUTH).sort(),
	);
});

for (const overrides of [
	{ hardened: true },
	{ hardened: false, privateNetworking: "true" },
])
	it(`private networking audits public network access too, ${JSON.stringify(overrides)}`, () => {
		expect(named(assignments(overrides))).toEqual(
			[...Object.values(LOCAL_AUTH), ...Object.values(NETWORK)].sort(),
		);
	});

it("every assignment audits and none denies", () => {
	for (const hardened of [false, true])
		for (const a of assignments({ hardened })) {
			expect(a.parameters.effect.value).toBe("Audit");
			expect(a.enforcementMode).toBe("Default");
		}
});

it("POLICY_AUDIT=false assigns nothing", () => {
	for (const hardened of [false, true])
		expect(assignments({ hardened, policyAudit: false })).toEqual([]);
});
