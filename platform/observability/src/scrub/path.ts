/**
 * A path as it may be recorded: every value-shaped segment collapsed to one
 * placeholder, so a span is named after its route and never after the thing
 * somebody asked for.
 *
 * The posture is deny-by-default: a segment survives only when it reads like
 * a route word. Enumerating what an id looks like is the same game with the
 * default the wrong way round — `image.jpg`, `12`, a hash and `owner::member`
 * are all not route words, so all of them become the placeholder without
 * anyone having to list them. What the default cannot tell apart is a value
 * that is itself a short plain word: `/users/alice` reads as two route words
 * and is kept, so a route that takes a name or a slug in its path declares
 * its pattern (`recordRoute`) rather than leaving the path to be guessed.
 */

/** The placeholder every redacted segment collapses to. */
export const ID_PLACEHOLDER = ":id";

/** 8-4-4-4-12, any case. Checked first because a UUID can read as a word. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route word: starts with a letter, then letters, digits, `-` or `_`, no
 * longer than a route name plausibly is. No dot — a segment with a dot is a
 * filename, and a filename is a thing somebody named after themselves.
 */
const ROUTE_WORD = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/** A segment that is already a route pattern (`:id`, `[...path]`, `{key}`, `*`). */
function isPattern(segment: string): boolean {
	const first = segment[0];
	return first === ":" || first === "{" || first === "[" || first === "*";
}

/**
 * One segment, kept or replaced. The UUID test runs before the route-word
 * test because a UUID beginning with a letter satisfies both; a long word
 * carrying a digit is an opaque id far more often than a route (`sha256`, at
 * six characters, is the exception the length bound is for).
 */
export function redactSegment(segment: string): string {
	if (segment === "" || isPattern(segment)) return segment;
	if (UUID.test(segment)) return ID_PLACEHOLDER;
	if (/^\d+$/.test(segment)) return ID_PLACEHOLDER;
	if (segment.length >= 8 && /\d/.test(segment)) return ID_PLACEHOLDER;
	if (!ROUTE_WORD.test(segment)) return ID_PLACEHOLDER;
	return segment;
}

/**
 * Leading and trailing slashes survive: a route's shape is part of what makes
 * two spans the same span, and `/a/b/` can be a different route from `/a/b`.
 */
export function redactPath(pathname: string): string {
	if (pathname === "") return "/";
	return pathname.split("/").map(redactSegment).join("/");
}

/**
 * The pathname of a URL without parsing one, for the request wrapper that
 * runs on every call. Anything that is not an absolute path answers `/`,
 * which is the safe answer: an unrecognised URL is not a probe and its path is
 * not something to pass through as if it had been redacted.
 */
export function pathOf(rawUrl: string): string {
	const schemeEnd = rawUrl.indexOf("://");
	const start = schemeEnd === -1 ? 0 : rawUrl.indexOf("/", schemeEnd + 3);
	if (start === -1) return "/";
	let stop = rawUrl.length;
	for (let i = start; i < rawUrl.length; i++) {
		const c = rawUrl[i];
		if (c === "?" || c === "#") {
			stop = i;
			break;
		}
	}
	const path = rawUrl.slice(start, stop);
	return path.startsWith("/") ? path : "/";
}

/** The span name: method and route, never the path as requested. */
export function spanNameFor(method: string, route: string): string {
	const verb = method.toUpperCase();
	return route ? `${verb} ${route}` : verb;
}
