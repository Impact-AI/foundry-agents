import { expect, test } from "bun:test";
import { assertDeploymentSafe } from "@platform/config/deployment-guard";
import { checkCosmos } from "./access";
import { type CosmosDatabase, CosmosStatusError } from "./container";
import { cosmosDeploymentRules } from "./deployment-rules";
import { fakeCosmosDatabase } from "./testing";

const ACCOUNTS = { name: "accounts", partitionKey: "/id" } as const;

function refusing(status: number): CosmosDatabase {
	return {
		container: () => {
			throw new Error("not reached");
		},
		verify: async () => {
			throw new CosmosStatusError(status, "refused");
		},
	};
}

test("the start is admitted, waits while the role is not yet applied, and fails on anything else", async () => {
	expect(await checkCosmos([ACCOUNTS], fakeCosmosDatabase([ACCOUNTS]))).toBe(
		"admitted",
	);
	expect(await checkCosmos([ACCOUNTS], refusing(403))).toBe("awaiting-roles");
	await expect(checkCosmos([ACCOUNTS], refusing(404))).rejects.toThrow(
		"refused",
	);
	await expect(
		checkCosmos(
			[ACCOUNTS],
			fakeCosmosDatabase([{ name: "accounts", partitionKey: "/email" }]),
		),
	).rejects.toThrow(/partitioned by \/email, not \/id/);
});

test("a deployed replica refuses to start with the emulator's key", () => {
	const deployed = { CONTAINER_APP_NAME: "backend" };
	expect(() =>
		assertDeploymentSafe(cosmosDeploymentRules, deployed),
	).not.toThrow();
	expect(() =>
		assertDeploymentSafe(cosmosDeploymentRules, {
			...deployed,
			COSMOS_KEY: "k",
		}),
	).toThrow(/COSMOS_KEY/);
	expect(() =>
		assertDeploymentSafe(cosmosDeploymentRules, { COSMOS_KEY: "k" }),
	).not.toThrow();
});
