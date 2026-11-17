import { CosmosClient, type Database } from "@azure/cosmos";
import { envString } from "@platform/config";
import { DEFAULT_DATABASE } from "./client";
import type { ContainerDefinition } from "./container";

/**
 * The emulator's database and containers, made where absent: what the
 * template does for a deployment, done for a laptop, a test or CI. Only
 * ever with the emulator's key, so null when `COSMOS_KEY` names none — a
 * deployment's identity may not create a container, since key-based
 * metadata writes are off on the account, and its containers are the
 * template's.
 */
export async function provisionEmulator(
	definitions: readonly ContainerDefinition[],
	id: string = envString("COSMOS_DATABASE") ?? DEFAULT_DATABASE,
): Promise<{ database: Database; close(): void } | null> {
	const endpoint = envString("COSMOS_ENDPOINT");
	const key = envString("COSMOS_KEY");
	if (!endpoint || !key) return null;
	const client = new CosmosClient({
		endpoint,
		key,
		connectionPolicy: { enableEndpointDiscovery: false },
	});
	const { database } = await client.databases.createIfNotExists({ id });
	for (const { name, partitionKey, compositeIndexes, itemTtl } of definitions) {
		const { container, resource } = await database.containers.createIfNotExists(
			{
				id: name,
				partitionKey: { paths: [partitionKey] },
				// On, with no default: only a document that names a lifetime has one.
				...(itemTtl ? { defaultTtl: -1 } : {}),
				...(compositeIndexes ? { indexingPolicy: { compositeIndexes } } : {}),
			},
		);
		// One made before its definition asked for lifetimes is given them, as a provision gives a deployment's.
		if (itemTtl && resource && typeof resource.defaultTtl !== "number")
			await container.replace({ ...resource, defaultTtl: -1 });
	}
	return { database, close: () => client.dispose() };
}
