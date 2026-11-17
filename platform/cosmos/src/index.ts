export { type CosmosAccess, checkCosmos } from "./access";
export { closeCosmos, cosmosDatabase, setCosmosDatabase } from "./client";
export {
	BATCH_MAX_BYTES,
	BATCH_MAX_OPERATIONS,
	type BatchOperation,
	type ContainerDefinition,
	type CosmosDatabase,
	type CosmosDocument,
	CosmosStatusError,
	type DocumentContainer,
	hasStatus,
	PATCH_MAX_OPERATIONS,
	type PatchSet,
	type QuerySpec,
	type Stored,
	type WriteConditions,
} from "./container";
export { cosmosDeploymentRules } from "./deployment-rules";
export { provisionEmulator } from "./emulator";
