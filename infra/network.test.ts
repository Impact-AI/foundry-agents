/**
 * The network's security groups and the Agent Service subnet's way out. The
 * data subnet's private endpoints call nothing, so its group refuses every
 * outbound flow. The agent subnet keeps the platform's default outbound
 * access unless `agentEgress` is `restricted`, which closes it, routes the
 * subnet through a NAT gateway, and admits only the private endpoints, the
 * subnet itself and the service tags Learn documents for the injection.
 * Bastion and the jump VM carry the baseline's groups. `apps` carries none:
 * its ingress is external and never crosses the subnet.
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

const NSG = "Microsoft.Network/networkSecurityGroups";
const NAT = "Microsoft.Network/natGateways";
const PUBLIC_IP = "Microsoft.Network/publicIPAddresses";

type Rule = {
	name: string;
	properties: {
		priority: number;
		direction: string;
		access: string;
		sourceAddressPrefix: string;
		destinationAddressPrefix: string;
		destinationPortRange?: string;
		destinationPortRanges?: string[];
	};
};

type Subnet = {
	name: string;
	addressPrefix: string;
	defaultOutboundAccess?: boolean;
	networkSecurityGroupResourceId?: unknown;
	natGatewayResourceId?: unknown;
	privateEndpointNetworkPolicies?: string;
};

function deployment(overrides: Record<string, unknown>): Deployment {
	const d = sampleDeployment(overrides);
	if (!d) throw new Error("no template");
	return d;
}

const live = (d: Deployment, type: string) =>
	allResources(d).filter((r) => r.type === type && r.condition);

function subnets(d: Deployment): Record<string, Subnet> {
	const network = moduleCalls(d).find(
		(m) => m.mainType === "Microsoft.Network/virtualNetworks",
	);
	if (!network) return {};
	const list = network.parameters.subnets as Subnet[];
	return Object.fromEntries(list.map((s) => [s.name, s]));
}

const groupNamed = (d: Deployment, fragment: string) =>
	live(d, NSG).find((r) => String(r.name).includes(`-${fragment}-`));

function props<T>(r: Resource | undefined): T {
	if (!r) throw new Error("no such resource");
	return r.properties as T;
}

const rules = (r: Resource | undefined) =>
	props<{ securityRules: Rule[] }>(r).securityRules;

/** What a group lets out, as `destination:ports`, in priority order, up to its first deny. */
function allowedOut(r: Resource | undefined): string[] {
	const out = rules(r)
		.filter((x) => x.properties.direction === "Outbound")
		.sort((a, b) => a.properties.priority - b.properties.priority);
	const firstDeny = out.findIndex((x) => x.properties.access === "Deny");
	return out
		.slice(0, firstDeny === -1 ? out.length : firstDeny)
		.map(
			(x) =>
				`${x.properties.destinationAddressPrefix}:${
					x.properties.destinationPortRange ??
					x.properties.destinationPortRanges?.join(",")
				}`,
		);
}

it("the demo has no network, so no security group and no NAT gateway, whatever agentEgress says", () => {
	const d = deployment({ hardened: false, agentEgress: "restricted" });
	expect(live(d, NSG)).toEqual([]);
	expect(live(d, NAT)).toEqual([]);
	expect(live(d, PUBLIC_IP)).toEqual([]);
});

for (const agentEgress of [undefined, "", "open"])
	it(`hardened, open by default (agentEgress ${JSON.stringify(agentEgress)}): the agent subnet keeps its default outbound access, unfiltered, and only the data subnet has a group`, () => {
		const d = deployment(
			agentEgress === undefined
				? { hardened: true }
				: { hardened: true, agentEgress },
		);
		const s = subnets(d);
		expect(s.agent?.defaultOutboundAccess).toBe(true);
		expect(s.agent?.networkSecurityGroupResourceId).toBeUndefined();
		expect(s.agent?.natGatewayResourceId).toBeUndefined();
		expect(live(d, NAT)).toEqual([]);
		expect(live(d, NSG).map((r) => String(r.name))).toEqual([
			expect.stringContaining("nsg-data-"),
		]);
	});

it("the private endpoints' subnet refuses every outbound flow, and its group applies to the endpoints", () => {
	const d = deployment({ hardened: true });
	const data = subnets(d).data;
	expect(data?.networkSecurityGroupResourceId).toBeTruthy();
	expect(data?.privateEndpointNetworkPolicies).toBe("Enabled");
	expect(allowedOut(groupNamed(d, "data"))).toEqual([]);
	// Inbound is the defaults: the network reaches the endpoints.
	expect(
		rules(groupNamed(d, "data")).filter(
			(x) => x.properties.direction === "Inbound",
		),
	).toEqual([]);
});

it("the apps' subnet carries no group: its ingress is external and never crosses it", () => {
	expect(
		subnets(deployment({ hardened: true })).apps
			?.networkSecurityGroupResourceId,
	).toBeUndefined();
});

it("restricted: no default outbound access, a NAT gateway with a static address as the one way out, and a group on the subnet", () => {
	const d = deployment({ hardened: true, agentEgress: "restricted" });
	const agent = subnets(d).agent;
	expect(agent?.defaultOutboundAccess).toBe(false);
	expect(agent?.natGatewayResourceId).toBeTruthy();
	expect(agent?.networkSecurityGroupResourceId).toBeTruthy();
	const [nat] = live(d, NAT);
	expect(live(d, NAT)).toHaveLength(1);
	expect(
		props<{ publicIpAddresses: unknown[] }>(nat).publicIpAddresses,
	).toHaveLength(1);
	const [address] = live(d, PUBLIC_IP);
	expect(
		props<{ publicIPAllocationMethod: string }>(address)
			.publicIPAllocationMethod,
	).toBe("Static");
});

it("restricted lets out exactly the private endpoints, the subnet, and Entra ID, the artifact registry, its Front Door and Azure Monitor on 443", () => {
	const d = deployment({ hardened: true, agentEgress: "restricted" });
	const group = groupNamed(d, "agent");
	const s = subnets(d);
	expect(allowedOut(group)).toEqual([
		`${s.data?.addressPrefix}:*`,
		`${s.agent?.addressPrefix}:*`,
		"AzureActiveDirectory:443",
		"MicrosoftContainerRegistry:443",
		"AzureFrontDoor.FirstParty:443",
		"AzureMonitor:443",
	]);
	// Then nothing, and nothing in: the baseline's agent subnet.
	const deny = (direction: string) =>
		rules(group).find(
			(x) =>
				x.properties.direction === direction &&
				x.properties.access === "Deny" &&
				x.properties.destinationAddressPrefix === "*",
		);
	expect(deny("Outbound")).toBeTruthy();
	expect(deny("Inbound")).toBeTruthy();
	expect(
		rules(group).filter(
			(x) =>
				x.properties.direction === "Inbound" && x.properties.access === "Allow",
		),
	).toEqual([]);
	expect(allowedOut(group).some((x) => x.startsWith("Internet"))).toBe(false);
});

it("developer access brings Bastion's documented group and the jump VM's, which admits SSH from Bastion alone", () => {
	const d = deployment({
		hardened: true,
		developerAccess: true,
		developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
	});
	const s = subnets(d);
	expect(s.AzureBastionSubnet?.networkSecurityGroupResourceId).toBeTruthy();
	expect(s.jump?.networkSecurityGroupResourceId).toBeTruthy();
	const bastionIn = rules(groupNamed(d, "bastion"))
		.filter(
			(x) =>
				x.properties.direction === "Inbound" && x.properties.access === "Allow",
		)
		.map((x) => x.properties.sourceAddressPrefix);
	expect(bastionIn).toEqual([
		"Internet",
		"GatewayManager",
		"AzureLoadBalancer",
		"VirtualNetwork",
	]);
	const jumpIn = rules(groupNamed(d, "jump")).filter(
		(x) =>
			x.properties.direction === "Inbound" && x.properties.access === "Allow",
	);
	expect(jumpIn).toHaveLength(1);
	expect(jumpIn[0]?.properties.sourceAddressPrefix).toBe(
		s.AzureBastionSubnet?.addressPrefix,
	);
	expect(jumpIn[0]?.properties.destinationPortRange).toBe("22");
});
