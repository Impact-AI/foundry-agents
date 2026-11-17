export {
	type Account,
	type AdmittedAccount,
	beginErase,
	deleteAccount,
	ERASE_RENEW_SECONDS,
	ERASE_STALLED_SECONDS,
	ErasedSessionError,
	type EraseStart,
	EraseUnderWayError,
	eraseUnderWay,
	finishErase,
	getAccount,
	identityContainers,
	isAccountDisabled,
	PERSON_NAME_MAX,
	PERSON_TEXT_MAX,
	type PersonPatch,
	releaseErase,
	renewErase,
	setAccountDisabled,
	setVoiceTuning,
	underLease,
	updatePerson,
	upsertAccount,
} from "./accounts";
export {
	type Assertion,
	type AssertionPurpose,
	CALLER_ASSERTION_TTL_SECONDS,
	type CallerClaims,
	callerAssertion,
	defineAssertion,
	SCOPE_ASSERTION_TTL_SECONDS,
	type ScopeClaims,
	scopeAssertion,
} from "./assertions";
export * from "./claims";
export { identityDeploymentRules } from "./deployment-rules";
export {
	resolveSignIn,
	type SignInOptions,
	type SignInOutcome,
} from "./sign-in";
export {
	ACCOUNT_DEACTIVATED,
	ACCOUNT_ERASED,
	ACCOUNT_UNAVAILABLE,
	type AccountReading,
	type AccountStanding,
	readAccountStanding,
	type StandingRefusal,
	standingRefusal,
} from "./standing";
