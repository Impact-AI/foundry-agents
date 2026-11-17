import { pathOf, redactPath } from "./path";

/**
 * A URL as it may be recorded: scheme, host, redacted path, and the few query
 * keys that describe the request rather than the requester.
 *
 * The query string is dropped entirely unless a key is on the allowlist, and
 * even then the value has to be short and boring. A new route cannot leak
 * through a parameter nobody thought about, because a parameter nobody
 * thought about is not on the list.
 */

/**
 * Keep this short and boring: every addition is a new way for something
 * identifying to reach the store. Absent on purpose: `url`, `id`, `q`,
 * `email`, `token`, `key`, `sig`, `se`, `sp`, `sv`.
 */
export const SAFE_QUERY_KEYS: ReadonlySet<string> = new Set([
	"format",
	"kind",
	"limit",
	"locale",
	"mode",
	"offset",
	"order",
	"page",
	"sort",
	"type",
]);

/** `locale=en` passes; a base64 blob under `type=` does not. */
const SAFE_VALUE = /^[A-Za-z0-9_.-]{1,32}$/;

/** `""` when nothing survives, so a scrubbed URL does not end in a bare `?`. */
export function scrubQuery(params: URLSearchParams): string {
	const kept = new URLSearchParams();
	for (const [key, value] of params) {
		if (SAFE_QUERY_KEYS.has(key) && SAFE_VALUE.test(value))
			kept.append(key, value);
	}
	const rendered = kept.toString();
	return rendered ? `?${rendered}` : "";
}

/**
 * Userinfo goes with the authority, the fragment with the query, and a URL
 * that will not parse is reported as the empty string: an unparseable URL is
 * exactly the shape a hand-built string carrying a token tends to have.
 */
export function scrubUrl(raw: string): string {
	// `http.target` is a path with a query and no origin, which is not a URL; a
	// placeholder base lets one parser serve both spellings and never appears in
	// what comes back.
	const relative = raw.startsWith("/");
	let url: URL;
	try {
		url = relative ? new URL(raw, "http://relative.invalid") : new URL(raw);
	} catch {
		return "";
	}
	const path = redactPath(url.pathname);
	const query = scrubQuery(url.searchParams);
	return relative
		? `${path}${query}`
		: `${url.protocol}//${url.host}${path}${query}`;
}

/** The redacted route a scrubbed URL names, with no query on it. */
export function routeOfScrubbed(scrubbed: string): string {
	const path = scrubbed.startsWith("/")
		? scrubbed
		: redactPath(pathOf(scrubbed));
	return path.split("?")[0] ?? "/";
}
