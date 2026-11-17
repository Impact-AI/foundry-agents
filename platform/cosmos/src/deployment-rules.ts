import {
	type DeploymentRule,
	forbidWhenSet,
} from "@platform/config/deployment-guard";

/** The rules this package owns, for an app to pass to `assertDeploymentSafe`. */
export const cosmosDeploymentRules: readonly DeploymentRule[] = [
	forbidWhenSet(
		"COSMOS_KEY",
		"it is the emulator's key; a deployment reaches Cosmos DB as its own identity, with local authentication off on the account",
	),
];
