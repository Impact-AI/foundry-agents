/**
 * For tests: the provider stood in for at its one boundary, the fetch every
 * request goes through, and an environment set for the duration of a test.
 * Everything above that boundary — the token, the bounds, the usage line,
 * the request a client assembles — runs for real. A package built on these
 * models tests at the same boundary.
 */
export {
	completedResponse,
	completion,
	json,
	refusal,
} from "./answers";
export { configure, TOKEN } from "./configure";
export {
	type Answer,
	fakeAzure,
	type RecordedRequest,
	recordRequests,
} from "./record-requests";
