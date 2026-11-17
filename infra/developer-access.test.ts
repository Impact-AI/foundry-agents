/**
 * Developer access is opt-in and only inside a network: off, or without
 * private networking, nothing of it exists; on, Azure Bastion and a jump VM
 * with no public address, signed in to with Microsoft Entra ID by the
 * deploying principal, and nothing that admits a password.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	allResources,
	compiledMain,
	type Deployment,
	instantiate,
	moduleCalls,
	type Resource,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

/** Virtual Machine Administrator Login, a built-in role. */
const VM_ADMIN_LOGIN = "1c0163c0-47e6-4577-8991-ea5c82e286e4";

/** The default: a size a region allocates where it refuses the burstable B-series with AllocationFailed. */
const DEFAULT_VM_SIZE = "Standard_D2as_v5";

function live(overrides: Record<string, unknown>): Resource[] {
	return allResources(sampleDeployment(overrides) as Deployment).filter(
		(r) => r.condition,
	);
}

/** How a value only a live deployment answers reads once it is written into a text. */
const LIVE_ANSWER = /<(reference|list\w*|copy|map|filter|sort|flatten)\(/i;
/** Such a value itself, as the evaluator hands it on. */
const isLive = (value: unknown) =>
	value !== null &&
	typeof value === "object" &&
	typeof (value as { path?: unknown }).path === "string";

const of = (resources: Resource[], type: string) =>
	resources.filter((r) => r.type === type);

it("off by default, and on without private networking, there is no Bastion, no VM and no room made for them", () => {
	for (const overrides of [
		{ hardened: true },
		{ hardened: false, developerAccess: true },
		{ hardened: true, privateNetworking: "false", developerAccess: true },
	]) {
		const resources = live(overrides);
		expect(of(resources, "Microsoft.Network/bastionHosts")).toEqual([]);
		expect(of(resources, "Microsoft.Compute/virtualMachines")).toEqual([]);
		for (const subnet of of(
			resources,
			"Microsoft.Network/virtualNetworks/subnets",
		))
			expect(["apps", "data", "agent"]).toContain(
				String(subnet.name).split("/").pop(),
			);
	}
});

it("on, a Basic Bastion and a VM with no public address and no password, signed in to with Entra ID by the deploying principal", () => {
	const resources = live({
		hardened: true,
		developerAccess: true,
		developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
	});
	const bastions = of(resources, "Microsoft.Network/bastionHosts");
	expect(bastions).toHaveLength(1);
	const vms = of(resources, "Microsoft.Compute/virtualMachines");
	expect(vms).toHaveLength(1);
	const vm = vms[0]?.properties as {
		osProfile: {
			linuxConfiguration: { disablePasswordAuthentication: boolean };
		};
	};
	expect(vm.osProfile.linuxConfiguration.disablePasswordAuthentication).toBe(
		true,
	);
	// The login extension refuses to install on a VM with no identity of its own.
	const vmCall = moduleCalls(
		sampleDeployment({
			hardened: true,
			developerAccess: true,
			developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
		}) as Deployment,
	).find((m) => m.path.at(-1) === "jump-vm");
	expect(vmCall?.parameters.managedIdentities).toEqual({
		systemAssigned: true,
	});
	// The one public address is the Bastion host's own; the VM has none.
	const addresses = of(resources, "Microsoft.Network/publicIPAddresses");
	expect(addresses.map((r) => String(r.name))).toEqual([
		`${String(bastions[0]?.name)}-pip`,
	]);
	// One login extension, spelled as the published image is: the portal's
	// Bastion Entra ID check failed on a VM with the Verified Module's
	// `AADSSHLoginforLinux` (lowercase f), so the template declares it itself.
	const extensions = of(
		resources,
		"Microsoft.Compute/virtualMachines/extensions",
	);
	expect(extensions).toHaveLength(1);
	expect(String(extensions[0]?.name).split("/").pop()).toBe(
		"AADSSHLoginForLinux",
	);
	expect(extensions[0]?.properties).toEqual({
		publisher: "Microsoft.Azure.ActiveDirectory",
		type: "AADSSHLoginForLinux",
		typeHandlerVersion: "1.0",
		autoUpgradeMinorVersion: true,
	});
	expect(extensions[0]?.dependsOn ?? []).not.toEqual([]);
	const logins = of(
		resources,
		"Microsoft.Authorization/roleAssignments",
	).filter((r) =>
		String(
			(r.properties as { roleDefinitionId: unknown }).roleDefinitionId,
		).includes(VM_ADMIN_LOGIN),
	);
	expect(
		logins.map((r) => (r.properties as { principalId: unknown }).principalId),
	).toEqual(["11111111-2222-3333-4444-555555555555"]);
	const subnets = of(
		resources,
		"Microsoft.Network/virtualNetworks/subnets",
	).map((s) => String(s.name).split("/").pop());
	expect(subnets).toEqual(
		expect.arrayContaining(["AzureBastionSubnet", "jump"]),
	);
});

it("on, the outputs name the VM and the Bastion host from the jump module; off, they are empty", () => {
	const outputs = (overrides: Record<string, unknown>) => {
		const d = sampleDeployment(overrides) as Deployment;
		return ["BASTION_NAME", "JUMP_HOST_NAME"].map((name) => d.outputs[name]);
	};
	expect(outputs({})).toEqual(["", ""]);
	expect(outputs({ hardened: true })).toEqual(["", ""]);
	expect(
		outputs({
			hardened: true,
			developerAccess: true,
			developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
		}),
	).toEqual([
		{ path: "reference(jump).outputs.bastionName.value" },
		{ path: "reference(jump).outputs.vmName.value" },
	]);
});

it("what the VM is created with names no other resource, so a provision never asks Azure to change it", () => {
	const d = sampleDeployment({
		hardened: true,
		developerAccess: true,
		developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
	}) as Deployment;
	const jump = d.resources.find((r) => r.symbol === "jump");
	// The cache is the resource a welcome text would name: the module is handed nothing of it and waits for none of it.
	expect(JSON.stringify(jump?.deployment?.parameters)).not.toContain("redis");
	expect(jump?.dependsOn).not.toContain("redis");
	const vm = of(allResources(d), "Microsoft.Compute/virtualMachines").find(
		(r) => r.condition,
	) as Resource & { properties: { osProfile: { customData: unknown } } };
	const customData = vm.properties.osProfile.customData;
	expect(typeof customData).toBe("string");
	expect(customData).toContain("<REDIS_HOST>");
	// Nothing in it is a live deployment's answer: such a value is written
	// into a text as the expression that would have asked for it.
	expect(customData).not.toMatch(LIVE_ANSWER);
	// And nothing in it is anything the module was handed: with every text it
	// takes replaced (the names, the ids, the outputs of the modules before
	// it), the VM is created with the same text.
	const module = jump?.deployment as Deployment;
	const poisoned = instantiate(
		module.template,
		Object.fromEntries(
			Object.entries(module.parameters).map(([name, value]) => [
				name,
				typeof value === "string" || isLive(value) ? `poison-${name}` : value,
			]),
		),
		module.name,
	);
	const again = of(
		allResources(poisoned),
		"Microsoft.Compute/virtualMachines",
	).find((r) => r.condition) as typeof vm;
	expect(JSON.stringify(poisoned.parameters)).toContain("poison-");
	expect(again.properties.osProfile.customData).toBe(customData);
	expect(d.outputs.REDIS_HOST).toEqual({
		path: "reference(redis).outputs.hostName.value",
	});
	expect(d.outputs.REDIS_PORT).toEqual({
		path: "reference(redis).outputs.port.value",
	});
});

it("the VM's size is the DEVELOPER_VM_SIZE knob, regional rather than zone-pinned, so an AllocationFailed is answered with another size", () => {
	const vm = (overrides: Record<string, unknown>) =>
		of(
			live({
				hardened: true,
				developerAccess: true,
				developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
				...overrides,
			}),
			"Microsoft.Compute/virtualMachines",
		)[0] as Resource & {
			properties: { hardwareProfile: { vmSize: string } };
		};
	expect(vm({}).properties.hardwareProfile.vmSize).toBe(DEFAULT_VM_SIZE);
	// The module is asked for no zone, and the compiled VM carries none.
	expect(vm({}).zones ?? []).toEqual([]);
	const asked = (
		sampleDeployment({
			hardened: true,
			developerAccess: true,
			developerAccessSshKey: "ssh-ed25519 AAAA jump-host",
		}) as Deployment
	).resources
		.find((r) => r.symbol === "jump")
		?.deployment?.resources.find((r) => r.symbol === "vm");
	expect(asked?.deployment?.parameters.availabilityZone).toBe(-1);
	expect(
		vm({ developerVmSize: "Standard_D2s_v5" }).properties.hardwareProfile
			.vmSize,
	).toBe("Standard_D2s_v5");
	const parameters = JSON.parse(
		readFileSync(join(import.meta.dir, "main.parameters.json"), "utf8"),
	).parameters;
	expect(parameters.developerVmSize.value).toBe(
		`\${DEVELOPER_VM_SIZE=${DEFAULT_VM_SIZE}}`,
	);
});
