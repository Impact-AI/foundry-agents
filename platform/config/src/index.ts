export * from "./app-configuration";
export {
	azureCredential,
	resetAzureCredential,
	setAzureCredential,
} from "./azure-credential";
export {
	isConflict,
	isForbidden,
	isNotFound,
	isPreconditionFailed,
} from "./azure-errors";
export {
	type ConfigKey,
	type ConfigKeyOptions,
	defineConfigKey,
	type SharedCache,
} from "./config-key";
export { withDeadline } from "./deadline";
export {
	type AccessTokenLike,
	createEntraAccessTokenProvider,
	createEntraTokenProvider,
	DEFAULT_MINT_TIMEOUT_MS,
	DEFAULT_REFRESH_MARGIN_MS,
	type EntraAccessTokenProvider,
	type EntraTokenProvider,
	type EntraTokenProviderOptions,
	type TokenCredentialLike,
} from "./entra-token";
export {
	configTtlMs,
	DEFAULT_CONFIG_TTL_MS,
	envChoice,
	envFlag,
	envInt,
	envString,
	type IntRange,
	isOn,
} from "./env";
export {
	atLeast,
	integerBetween,
	type LeafRule,
	type MergeOptions,
	mergeOverDefault,
	nonNegativeInteger,
	numberBetween,
	oneOf,
	positiveInteger,
	positiveNumber,
	sameKind,
	stringList,
} from "./merge";
export {
	failureReason,
	reportFailure,
	type ThrottledReport,
	type ThrottledReportOptions,
	throttledReport,
} from "./report";
export {
	hasSingleton,
	processSingleton,
	resetSingleton,
	setSingleton,
} from "./singleton";
