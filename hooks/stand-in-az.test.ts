/**
 * The stand-in `az` is held to what it stands in for where a test rests on
 * it: it keeps the account as the calls leave it, and it refuses a flag the
 * real command does not take, so a mistyped one fails in either twin.
 */
import { expect, test } from "bun:test";
import { standInAz } from "./stand-in-az";

function az(stand: ReturnType<typeof standInAz>, ...args: string[]) {
	const run = Bun.spawnSync(["az", ...args], {
		env: stand.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: run.exitCode,
		stdout: run.stdout.toString().trim(),
		stderr: run.stderr.toString().trim(),
	};
}
const ACCOUNT = ["--subscription", "sub", "-g", "rg", "-n", "store"];
const FIREWALL = [
	"--subscription",
	"sub",
	"-g",
	"rg",
	"--account-name",
	"store",
];

test("the account answers what the calls left it: the listener as it was last set, the rules added and not removed", () => {
	const stand = standInAz("Succeeded", { publicNetworkAccess: "Disabled" });
	const show = () =>
		az(stand, "storage", "account", "show", ...ACCOUNT, "-o", "tsv").stdout;
	expect(show()).toBe("Disabled");
	az(
		stand,
		"storage",
		"account",
		"update",
		...ACCOUNT,
		"--public-network-access",
		"Enabled",
	);
	expect(show()).toBe("Enabled");
	for (const ip of ["203.0.113.7", "198.51.100.9", "203.0.113.7"])
		az(
			stand,
			"storage",
			"account",
			"network-rule",
			"add",
			...FIREWALL,
			"--ip-address",
			ip,
		);
	az(
		stand,
		"storage",
		"account",
		"network-rule",
		"remove",
		...FIREWALL,
		"--ip-address",
		"198.51.100.9",
	);
	expect(
		az(stand, "storage", "account", "network-rule", "list", ...FIREWALL).stdout,
	).toBe("203.0.113.7");
	// The tag the ingest script keeps on the account: merged, answered beside
	// the listener and the firewall's default, and taken off.
	const TAG = [
		"tag",
		"update",
		"--subscription",
		"sub",
		"--resource-id",
		"/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/store",
	];
	const tagged = "0a1b2c3d:203.0.113.7:listener+rule:17";
	az(
		stand,
		...TAG,
		"--operation",
		"Merge",
		"--tags",
		`ingestListener=${tagged}`,
	);
	expect(
		az(
			stand,
			"storage",
			"account",
			"show",
			...ACCOUNT,
			"--query",
			"[publicNetworkAccess, networkRuleSet.defaultAction, tags.ingestListener || '']",
			"-o",
			"tsv",
		).stdout.split("\n"),
	).toEqual(["Enabled", "Deny", tagged]);
	expect(stand.state()).toEqual({
		publicNetworkAccess: "Enabled",
		ipRules: ["203.0.113.7"],
		defaultAction: "Deny",
		tag: tagged,
	});
	// A stand-in that carries on from this one starts where it ended.
	expect(standInAz("Succeeded", { from: stand.bin }).state()).toEqual(
		stand.state(),
	);
	az(
		stand,
		...TAG,
		"--operation",
		"Delete",
		"--tags",
		`ingestListener=${tagged}`,
	);
	expect(stand.state().tag).toBe("");
});

test("a flag the real command does not take is refused, and changes nothing; a command the scripts do not use is not checked", () => {
	const stand = standInAz("Succeeded", { publicNetworkAccess: "Disabled" });
	const mistyped = az(
		stand,
		"storage",
		"account",
		"update",
		...ACCOUNT,
		"--public-network-acess",
		"Enabled",
	);
	expect(mistyped.exitCode).toBe(2);
	expect(mistyped.stderr).toContain(
		"unrecognized arguments: --public-network-acess",
	);
	expect(stand.state().publicNetworkAccess).toBe("Disabled");
	expect(
		az(stand, "storage", "blob", "list", "--account", "store").exitCode,
	).toBe(2);
	expect(az(stand, "group", "exists", "--anything", "x").exitCode).toBe(0);
});
