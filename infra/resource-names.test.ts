/**
 * Every name the template derives, measured against Azure's limit and
 * character rules for the thing it names, at the longest environment name
 * azd allows. A name that fits one environment and not another is the
 * failure only a different environment can see, so the arithmetic is done
 * here for all of them.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compiledMain, INFRA, moduleCalls, sampleDeployment } from "./arm";

/** Azure's own rules per resource type: maximum length and the characters allowed. */
const RULES: Record<string, { max: number; pattern: RegExp }> = {
	"Microsoft.Resources/resourceGroups": { max: 90, pattern: /^[-\w.()]+$/ },
	"Microsoft.OperationalInsights/workspaces": { max: 63, pattern: /^[-\w]+$/ },
	"Microsoft.Insights/components": { max: 260, pattern: /^[^%&\\?/]+$/ },
	"Microsoft.ContainerRegistry/registries": {
		max: 50,
		pattern: /^[a-zA-Z0-9]{5,}$/,
	},
	"Microsoft.Network/virtualNetworks": { max: 64, pattern: /^[-\w.]+$/ },
	"Microsoft.Network/privateDnsZones": { max: 63, pattern: /^[-\w.]+$/ },
	"Microsoft.ManagedIdentity/userAssignedIdentities": {
		max: 128,
		pattern: /^[-\w]+$/,
	},
	"Microsoft.App/managedEnvironments": { max: 32, pattern: /^[-a-z0-9]+$/ },
	"Microsoft.App/containerApps": {
		max: 32,
		pattern: /^[a-z][-a-z0-9]*[a-z0-9]$/,
	},
	"Microsoft.App/jobs": { max: 32, pattern: /^[a-z][-a-z0-9]*[a-z0-9]$/ },
	"Microsoft.Cache/redisEnterprise": {
		max: 60,
		pattern: /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/,
	},
	"Microsoft.Search/searchServices": {
		max: 60,
		pattern: /^[a-z0-9][-a-z0-9]*$/,
	},
	"Microsoft.CognitiveServices/accounts": {
		max: 64,
		pattern: /^[-a-zA-Z0-9]+$/,
	},
	"Microsoft.AppConfiguration/configurationStores": {
		max: 50,
		pattern: /^[-a-zA-Z0-9]{5,}$/,
	},
	"Microsoft.KeyVault/vaults": { max: 24, pattern: /^[a-zA-Z][-a-zA-Z0-9]*$/ },
	"Microsoft.Storage/storageAccounts": { max: 24, pattern: /^[a-z0-9]{3,}$/ },
	"Microsoft.DocumentDB/databaseAccounts": {
		max: 44,
		pattern: /^[a-z0-9][-a-z0-9]{2,}$/,
	},
	"Microsoft.Cdn/profiles": { max: 260, pattern: /^[-a-zA-Z0-9]+$/ },
	"Microsoft.Network/FrontDoorWebApplicationFirewallPolicies": {
		max: 128,
		pattern: /^[a-zA-Z0-9]+$/,
	},
};

const LONGEST_ENVIRONMENT_NAME = "e".repeat(64);

const it = test.skipIf(compiledMain() === null);

function topLevelNames(): { type: string; name: string }[] {
	const d = sampleDeployment({
		environmentName: LONGEST_ENVIRONMENT_NAME,
		hardened: true,
	});
	if (!d) throw new Error("no template");
	return moduleCalls(d)
		.filter((m) => m.path.length <= 2)
		.map((m) => ({ type: m.mainType, name: String(m.parameters.name) }));
}

it("every derived name fits its type's limit and character rules", () => {
	for (const { type, name } of topLevelNames()) {
		const rule = RULES[type];
		expect(rule, `${type} has no rule; add Azure's limit for it`).toBeDefined();
		expect(name.length, `${type} ${name}`).toBeLessThanOrEqual(rule.max);
		expect(name, `${type} ${name}`).toMatch(rule.pattern);
	}
});

it("every name starts with its abbreviation", () => {
	const abbreviations = Object.values(
		JSON.parse(
			readFileSync(join(INFRA, "abbreviations.json"), "utf8"),
		) as Record<string, string>,
	);
	for (const { type, name } of topLevelNames()) {
		if (type === "Microsoft.Network/privateDnsZones") continue;
		expect(
			abbreviations.some((a) => name.startsWith(a)),
			`${type} ${name}`,
		).toBe(true);
	}
});

it("only the resource group carries the environment name; everything else is a token", () => {
	for (const { type, name } of topLevelNames()) {
		if (type === "Microsoft.Resources/resourceGroups")
			expect(name).toContain(LONGEST_ENVIRONMENT_NAME);
		else expect(name).not.toContain("eeee");
	}
});
