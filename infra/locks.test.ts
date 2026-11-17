/**
 * Hardened, everything that holds data nobody can recreate carries a
 * CanNotDelete lock; the demo locks nothing, and `lockDataResources=false`
 * lifts every one of them on a hardened deployment too, which is what the
 * predown hook relies on.
 */
import { expect, test } from "bun:test";
import {
	allResources,
	compiledMain,
	moduleCalls,
	sampleDeployment,
} from "./arm";

const DATA = [
	"Microsoft.Storage/storageAccounts",
	"Microsoft.KeyVault/vaults",
	"Microsoft.Search/searchServices",
	"Microsoft.AppConfiguration/configurationStores",
	"Microsoft.DocumentDB/databaseAccounts",
];

const it = test.skipIf(compiledMain() === null);

function locksOf(
	deployment: NonNullable<ReturnType<typeof sampleDeployment>>,
	type: string,
) {
	const call = moduleCalls(deployment).find(
		(m) => m.path.length === 2 && m.mainType === type,
	);
	if (!call) throw new Error(`${type} is not provisioned`);
	return allResources(call.deployment).filter(
		(r) =>
			r.type === "Microsoft.Authorization/locks" &&
			r.condition &&
			r.path.length === 0,
	);
}

it("locks every data resource when hardened", () => {
	const d = sampleDeployment({ hardened: true });
	if (!d) return;
	for (const type of DATA) {
		const locks = locksOf(d, type);
		expect(locks.length, type).toBe(1);
		expect((locks[0].properties as { level: string }).level, type).toBe(
			"CanNotDelete",
		);
	}
});

it("lifts all of them when asked, and nothing else is ever locked", () => {
	const d = sampleDeployment({ hardened: true, lockDataResources: "false" });
	if (!d) return;
	const locked = allResources(d).filter(
		(r) => r.type === "Microsoft.Authorization/locks" && r.condition,
	);
	expect(locked).toEqual([]);
});

it("the demo locks nothing", () => {
	const d = sampleDeployment();
	if (!d) return;
	const locked = allResources(d).filter(
		(r) => r.type === "Microsoft.Authorization/locks" && r.condition,
	);
	expect(locked).toEqual([]);
});
