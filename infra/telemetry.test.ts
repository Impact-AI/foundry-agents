/**
 * Telemetry ingestion is public by default, on every deployment.
 * PRIVATE_TELEMETRY=true, with private networking, opts in to the private
 * path: Application Insights and its Log Analytics workspace refuse public
 * ingestion, and an Azure Monitor private link scope holding both takes it
 * instead, through one private endpoint in the data subnet registered in
 * Azure Monitor's four private DNS zones, as Microsoft's private-network
 * Agent Service sample does it. Query stays open either way. Opt-in because
 * the private path has refused the apps' own telemetry (decision 29).
 */
import { expect, test } from "bun:test";
import {
	allResources,
	compiledMain,
	type Deployment,
	moduleCalls,
	type Resource,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const SCOPE = "Microsoft.Insights/privateLinkScopes";
const SCOPED = "Microsoft.Insights/privateLinkScopes/scopedResources";
const ENDPOINT = "Microsoft.Network/privateEndpoints";
const ZONE_GROUP = "Microsoft.Network/privateEndpoints/privateDnsZoneGroups";

const MONITOR_ZONES = [
	"privatelink.monitor.azure.com",
	"privatelink.oms.opinsights.azure.com",
	"privatelink.ods.opinsights.azure.com",
	"privatelink.agentsvc.azure-automation.net",
];

function deployment(overrides: Record<string, unknown>): Deployment {
	const d = sampleDeployment(overrides);
	if (!d) throw new Error("no template");
	return d;
}

// Bicep writes this provider's namespace in lower case for some types.
const live = (d: Deployment, type: string) =>
	allResources(d).filter(
		(r) => r.type.toLowerCase() === type.toLowerCase() && r.condition,
	);

/** The ingestion and query access each of the two monitoring resources is given. */
function access(d: Deployment) {
	return Object.fromEntries(
		[
			"Microsoft.OperationalInsights/workspaces",
			"Microsoft.Insights/components",
		].map((type) => {
			const p = moduleCalls(d).find((m) => m.mainType === type)?.parameters;
			return [
				type,
				{
					ingestion: p?.publicNetworkAccessForIngestion,
					query: p?.publicNetworkAccessForQuery,
				},
			];
		}),
	);
}

function props<T>(r: Resource | undefined): T {
	if (!r) throw new Error("no such resource");
	return r.properties as T;
}

const zonesNamed = (d: Deployment) =>
	live(d, "Microsoft.Network/privateDnsZones").map((r) => String(r.name));

for (const overrides of [
	{ hardened: false },
	{ hardened: true },
	{ hardened: false, privateTelemetry: "true" },
	{ hardened: true, privateTelemetry: "false" },
	{ hardened: true, privateNetworking: "false", privateTelemetry: "true" },
])
	it(`public ingestion and no private link scope, ${JSON.stringify(overrides)}`, () => {
		const d = deployment(overrides);
		expect(live(d, SCOPE)).toEqual([]);
		for (const a of Object.values(access(d)))
			expect(a).toEqual({ ingestion: "Enabled", query: "Enabled" });
		for (const zone of MONITOR_ZONES) expect(zonesNamed(d)).not.toContain(zone);
	});

for (const overrides of [
	{ hardened: true, privateTelemetry: "true" },
	{ hardened: false, privateNetworking: "true", privateTelemetry: "true" },
])
	it(`opted in with private networking, telemetry goes through the private link scope, ingestion closed and query open, ${JSON.stringify(overrides)}`, () => {
		const d = deployment(overrides);
		for (const a of Object.values(access(d)))
			expect(a).toEqual({ ingestion: "Disabled", query: "Enabled" });

		const scopes = live(d, SCOPE);
		expect(scopes).toHaveLength(1);
		expect(
			props<{ accessModeSettings: unknown }>(scopes[0]).accessModeSettings,
		).toEqual({ ingestionAccessMode: "PrivateOnly", queryAccessMode: "Open" });

		// Both resources are in the scope.
		const linked = live(d, SCOPED).map((r) =>
			String((r.properties as { linkedResourceId: unknown }).linkedResourceId),
		);
		expect(linked).toHaveLength(2);
		expect(linked.some((id) => id.includes("insightsId"))).toBe(true);
		expect(linked.some((id) => id.includes("workspaceId"))).toBe(true);

		// One endpoint in the data subnet, on the scope's `azuremonitor` group,
		// registered in the four zones, which the network links.
		const endpoint = live(d, ENDPOINT).find((r) =>
			String(r.name).includes("ampls-"),
		);
		const connection = props<{
			subnet: { id: unknown };
			privateLinkServiceConnections: {
				properties: { groupIds: string[] };
			}[];
		}>(endpoint);
		expect(String(connection.subnet.id)).toContain("dataSubnetId");
		expect(
			connection.privateLinkServiceConnections[0]?.properties.groupIds,
		).toEqual(["azuremonitor"]);
		for (const zone of MONITOR_ZONES) expect(zonesNamed(d)).toContain(zone);
		// The zone group registers the endpoint in the network's monitor zones
		// (a copy over an output only a live deployment resolves).
		const group = live(d, ZONE_GROUP).find((r) =>
			String(r.name).includes("ampls-"),
		);
		expect(JSON.stringify(group?.properties)).toContain(
			"outputs.monitorDnsZones",
		);
	});

it("the apps, the job and the project's connection keep the one Application Insights connection string, whichever way it is ingested", () => {
	for (const hardened of [false, true]) {
		const d = deployment({ hardened });
		const strings = allResources(d)
			.filter(
				(r) =>
					(r.type === "Microsoft.App/containerApps" ||
						r.type === "Microsoft.App/jobs") &&
					r.condition,
			)
			.map(
				(app) =>
					(
						app.properties as {
							template: {
								containers: { env: { name: string; value?: string }[] }[];
							};
						}
					).template.containers[0]?.env.find(
						(e) => e.name === "APPLICATIONINSIGHTS_CONNECTION_STRING",
					)?.value,
			);
		expect(strings.length).toBeGreaterThan(0);
		for (const value of strings) expect(String(value)).toContain("insights");
	}
});
