/**
 * What this app takes from `@platform/identity`: its database-free entries
 * only. The package root re-exports the account store, which reaches Cosmos
 * DB — a client this server has no identity for and no business opening —
 * and its type program carries the Bun globals, which must not enter beside
 * the DOM lib.
 */
export {
	type CallerClaims,
	callerAssertion,
} from "@platform/identity/assertions";
export type { SignInOutcome } from "@platform/identity/claims";
export { identityDeploymentRules } from "@platform/identity/deployment-rules";
