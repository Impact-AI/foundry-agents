/**
 * The operator and the principal that provisions. One person running
 * `azd up` is both, and holds the roles a person works with. A pipeline's
 * identity that provisions for an operator named with OPERATOR_PRINCIPAL_ID
 * holds none of them: the control plane is the deploying role's, and every
 * data-plane role, the Redis data policy and the jump VM's sign-in are the
 * operator's.
 */
import { expect, test } from "bun:test";
import {
	allResources,
	compiledMain,
	type Deployment,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

const DEPLOYER = "11111111-2222-3333-4444-555555555555";
const OPERATOR = "99999999-8888-7777-6666-555555555555";
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

/** Everything a principal is granted: each role with where it is, and each Redis data policy. */
function grants(d: Deployment, who: string): string[] {
	const live = allResources(d).filter((r) => r.condition);
	const roles = live
		.filter(
			(r) =>
				r.type === "Microsoft.Authorization/roleAssignments" ||
				r.type === "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments",
		)
		.map((r) => {
			const p = r.properties as {
				principalId: unknown;
				principalType?: string;
				roleDefinitionId: unknown;
				scope?: unknown;
			};
			return {
				who: String(p.principalId),
				what: `${String(p.roleDefinitionId).split("/").pop()} on ${String(p.scope ?? r.scope ?? "")} as ${p.principalType ?? "-"}`,
			};
		});
	// The Redis data policy, read from the assignments the compiled module makes.
	const policies = live
		.filter(
			(r) =>
				r.type ===
				"Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments",
		)
		.map((r) => ({
			who: String(
				(r.properties as { user: { objectId: unknown } }).user.objectId,
			),
			what: "redis data access",
		}));
	return [...roles, ...policies]
		.filter((g) => g.who === who)
		.map((g) => g.what)
		.sort();
}

for (const overrides of [{}, { hardened: true }, JUMP]) {
	it(`with no operator named, the provisioning principal is the operator: ${JSON.stringify(Object.keys(overrides))}`, () => {
		const d = deployment(overrides);
		expect(grants(d, DEPLOYER).length).toBeGreaterThan(0);
		expect(grants(d, OPERATOR)).toEqual([]);
	});

	it(`a named operator holds every grant the provisioning principal would, and that principal none: ${JSON.stringify(Object.keys(overrides))}`, () => {
		const alone = grants(deployment(overrides), DEPLOYER);
		const d = deployment({ ...overrides, operatorPrincipalId: OPERATOR });
		expect(grants(d, OPERATOR)).toEqual(alone);
		expect(grants(d, DEPLOYER)).toEqual([]);
	});
}

it("the operator's kind is its own: a group may operate what a pipeline's service principal provisions", () => {
	const d = deployment({
		principalType: "ServicePrincipal",
		operatorPrincipalId: OPERATOR,
		operatorPrincipalType: "Group",
	});
	const kinds = grants(d, OPERATOR)
		.map((g) => g.split(" as ").pop())
		.filter((kind) => kind !== "-");
	expect(new Set(kinds)).toEqual(new Set(["Group"]));
	// Unnamed, the operator's kind is the provisioning principal's, whatever OPERATOR_PRINCIPAL_TYPE says.
	const alone = deployment({
		principalType: "ServicePrincipal",
		operatorPrincipalType: "Group",
	});
	expect(
		new Set(
			grants(alone, DEPLOYER)
				.map((g) => g.split(" as ").pop())
				.filter((kind) => kind !== "-"),
		),
	).toEqual(new Set(["ServicePrincipal"]));
});

it("the jump VM is signed in to by the operator, and the cache admits the operator from it", () => {
	const d = deployment({ ...JUMP, operatorPrincipalId: OPERATOR });
	expect(grants(d, OPERATOR)).toContain("redis data access");
	const jump = d.resources.find((r) => r.symbol === "jump")?.deployment;
	expect(jump?.parameters.principalId).toBe(OPERATOR);
});

it("a group that operates signs in to the jump VM and holds the roles, and is not handed a Redis policy it could not dial with", () => {
	const d = deployment({
		...JUMP,
		operatorPrincipalId: OPERATOR,
		operatorPrincipalType: "Group",
	});
	expect(grants(d, OPERATOR)).not.toContain("redis data access");
	expect(grants(d, OPERATOR).length).toBeGreaterThan(0);
	const jump = d.resources.find((r) => r.symbol === "jump")?.deployment;
	expect(jump?.parameters.principalId).toBe(OPERATOR);
	expect(jump?.parameters.principalType).toBe("Group");
});
