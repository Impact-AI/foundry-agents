import { memoryContainer } from "@platform/agent";
import { threadContainers } from "@platform/agent/foundry";
import { identityContainers } from "@platform/identity";
import { promptContainers } from "@platform/prompt/store";

/**
 * The Cosmos DB containers this process reads, as its packages declare
 * them: what the start verifies against the database the template made, and
 * what a test or the dev server creates for itself.
 */
export const cosmosContainers = [
	...identityContainers,
	...threadContainers,
	memoryContainer,
	...promptContainers,
];
