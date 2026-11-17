/**
 * Codes cross the boundary; the catalogue renders them. Every `{ code }` the
 * backend's routes or this app's own can answer with is one of these, or is
 * read as one of these (`SAME_AS`), and each has a key under `errors` in
 * `messages/*.json`; `catalogue-parity.test.ts` holds both. Anything else
 * gets the generic line rather than a sentence invented at the call site.
 */
export const ERROR_CODES = [
	"unauthenticated",
	"forbidden",
	"not_found",
	"bad_request",
	"rate_limited",
	"pool_exhausted",
	"refused_capacity",
	"refused_busy",
	"refused_unavailable",
	"refused_unconfigured",
	"unconfigured",
	"invalid_body",
	"body_too_large",
	"upstream_failed",
	"handshake_failed",
	"settings_refused",
	"account_deactivated",
	"erase_incomplete",
	"unsupported_type",
	"unavailable",
	"backend_unreachable",
	"generic",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

/** The backend's refusal for a session whose account an erase took: the one 401 that means "erased" rather than "not signed in". */
export const ACCOUNT_ERASED = "account_erased";

/** Codes that say, for the person, what another already says. */
export const SAME_AS: Readonly<Record<string, ErrorCode>> = {
	invalid_path: "bad_request",
	invalid_query: "bad_request",
	invalid_value: "bad_request",
	no_such_measure: "not_found",
	no_account: "unauthenticated",
	[ACCOUNT_ERASED]: "unauthenticated",
	account_unavailable: "unavailable",
	"thread.unavailable": "unavailable",
	starting: "unavailable",
	draining: "unavailable",
	internal: "generic",
};

/** What a refusal body looks like on the wire, read defensively. */
interface ErrorBody {
	code?: unknown;
	reason?: unknown;
	pool?: unknown;
	retryAfterSeconds?: unknown;
}

/**
 * The code a body names. A voice refusal is `{ code: "refused", reason }` and
 * a shared-pool allowance is `{ code: "rate_limited", pool: true }`; both
 * want their own sentence, so the reason is folded into the code here, once.
 */
export function errorCodeOf(body: unknown, status?: number): ErrorCode {
	const b = (body ?? {}) as ErrorBody;
	if (b.code === "rate_limited")
		return b.pool === true ? "pool_exhausted" : "rate_limited";
	if (b.code === "refused" && typeof b.reason === "string") {
		if (b.reason === "allowance") return "rate_limited";
		if (b.reason === "pool") return "pool_exhausted";
		const folded = `refused_${b.reason}`;
		return KNOWN.has(folded) ? (folded as ErrorCode) : "generic";
	}
	// A typed turn on a thread a live session still holds: the same wait as the session's own refusal.
	if (b.code === "thread.busy") return "refused_busy";
	if (typeof b.code === "string") {
		if (KNOWN.has(b.code)) return b.code as ErrorCode;
		const same = SAME_AS[b.code];
		if (same) return same;
	}
	if (status === 401) return "unauthenticated";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 409) return "refused_busy";
	if (status === 429) return "rate_limited";
	return "generic";
}

/** The catalogue key for a code, for `useTranslations("errors")` callers. */
export function errorKey(code: string): ErrorCode {
	return KNOWN.has(code) ? (code as ErrorCode) : (SAME_AS[code] ?? "generic");
}

/** A `Retry-After`, or a body's field, as whole seconds; a minute when neither reads. */
export function retryAfterSeconds(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0
		? Math.ceil(n)
		: 60;
}
