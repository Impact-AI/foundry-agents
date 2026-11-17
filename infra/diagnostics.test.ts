/**
 * Every PaaS resource sends its platform logs and metrics to the one
 * workspace. A resource added without a diagnostic setting is invisible the
 * day it misbehaves, so the list below is checked against the module calls
 * the compiled template makes: each named type must be provisioned, and its
 * module must be handed the workspace and must actually declare the setting.
 */
import { expect, test } from "bun:test";
import {
	allResources,
	compiledMain,
	type ModuleCall,
	moduleCalls,
	sampleDeployment,
} from "./arm";

const PAAS = [
	"Microsoft.Insights/components",
	"Microsoft.Network/virtualNetworks",
	"Microsoft.ContainerRegistry/registries",
	"Microsoft.KeyVault/vaults",
	"Microsoft.AppConfiguration/configurationStores",
	"Microsoft.Cache/redisEnterprise",
	"Microsoft.Storage/storageAccounts",
	"Microsoft.Search/searchServices",
	"Microsoft.CognitiveServices/accounts",
	"Microsoft.DocumentDB/databaseAccounts",
	"Microsoft.App/managedEnvironments",
	"Microsoft.Cdn/profiles",
];

const it = test.skipIf(compiledMain() === null);

/** The template's own module calls, one level under main, with everything the hardened bundle adds. */
function tierCalls(): ModuleCall[] {
	const d = sampleDeployment({ hardened: true });
	if (!d) throw new Error("no template");
	return moduleCalls(d).filter((m) => m.path.length === 2);
}

it("provisions each PaaS type exactly once", () => {
	const types = tierCalls().map((m) => m.mainType);
	for (const type of PAAS)
		expect(types.filter((t) => t === type)).toHaveLength(1);
});

it("hands every PaaS module the workspace", () => {
	for (const call of tierCalls().filter((m) => PAAS.includes(m.mainType))) {
		const settings = call.parameters.diagnosticSettings as
			| { workspaceResourceId?: unknown }[]
			| null;
		expect(settings, call.mainType).toBeArray();
		expect(settings?.[0]?.workspaceResourceId, call.mainType).toBeTruthy();
	}
});

it("and every one of them declares the setting", () => {
	for (const call of tierCalls().filter((m) => PAAS.includes(m.mainType))) {
		const declared = allResources(call.deployment).filter(
			(r) =>
				r.type === "Microsoft.Insights/diagnosticSettings" &&
				r.condition &&
				r.path.length === 0,
		);
		expect(declared.length, call.mainType).toBeGreaterThanOrEqual(1);
		for (const setting of declared)
			expect(
				(setting.properties as { workspaceId: unknown }).workspaceId,
				call.mainType,
			).toBeTruthy();
	}
});

it("Application Insights sends metrics only: its logs are in the workspace already", () => {
	const call = tierCalls().find(
		(m) => m.mainType === "Microsoft.Insights/components",
	);
	const settings = call?.parameters.diagnosticSettings as {
		logCategoriesAndGroups?: unknown;
	}[];
	for (const setting of settings)
		expect(setting.logCategoriesAndGroups).toEqual([]);
});
