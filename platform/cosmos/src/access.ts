import { cosmosDatabase } from "./client";
import {
	type ContainerDefinition,
	type CosmosDatabase,
	hasStatus,
} from "./container";

export type CosmosAccess = "admitted" | "awaiting-roles";

/**
 * Whether the database admits this process's identity to the containers
 * its stores declare, each partitioned as declared. The template assigns
 * the data-plane role in the same deployment that starts the replica, and an
 * assignment can take minutes to apply, so a 403 is `awaiting-roles`, waited
 * out like a database login that does not exist yet; anything else — no
 * account, no database, a container missing or partitioned otherwise, no
 * answer — throws, and the start fails.
 */
export async function checkCosmos(
	containers: readonly ContainerDefinition[],
	database: CosmosDatabase = cosmosDatabase(),
): Promise<CosmosAccess> {
	try {
		await database.verify(containers);
		return "admitted";
	} catch (err) {
		if (hasStatus(err, 403)) return "awaiting-roles";
		throw err;
	}
}
