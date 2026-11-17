import { pathOf, redactPath } from "./path";
import { isProbePath } from "./probe";
import { routeOfScrubbed, scrubUrl } from "./query";
import { scrubText } from "./text";

/** A bag of attributes, in the shape both spans and log records carry one. */
export type AttributeBag = Record<string, unknown>;

/**
 * Attributes that hold a URL, in the current semantic-convention spelling and
 * the one older instrumentation still emits.
 */
export const URL_ATTRIBUTES = [
	"http.url",
	"http.target",
	"url.full",
	"url.path",
	"url.original",
] as const;

/**
 * Attributes that identify the caller rather than the call, dropped outright.
 *
 * Derived from what the instrumentation actually sets, not from what an IP
 * address is called: the HTTP instrumentation writes two addresses onto every
 * server span, `client.address` from `X-Forwarded-For` and
 * `network.peer.address` from the socket, and the `net.sock.peer.*` spellings
 * are the pre-1.0 names for the same values. `server.address` is deliberately
 * not here — it is the app's own hostname, which an application map needs and which
 * identifies nobody.
 */
export const DROPPED_ATTRIBUTES = [
	"client.address",
	"client.port",
	"client.socket.address",
	"http.client_ip",
	"net.peer.ip",
	"net.peer.name",
	"net.sock.peer.addr",
	"net.sock.peer.port",
	"network.peer.address",
	"network.peer.port",
	"http.request.header.cookie",
	"http.request.header.authorization",
	"http.response.header.set-cookie",
	"url.query",
	"user_agent.original",
	"enduser.id",
] as const;

/**
 * Attributes that hold prose some producer wrote around a value: an error's
 * message and stack on an exception event, and the name Next gives a span,
 * which for an outbound fetch is the method and the whole URL.
 */
export const TEXT_ATTRIBUTES = [
	"exception.message",
	"exception.stacktrace",
	"next.span_name",
] as const;

/**
 * Every attribute that can name a span's path, at either end of its life.
 * Next sets `http.target` when it starts a request span and `next.route` /
 * `http.route` only when it ends, so a sampling decision has `http.target`
 * and a processor has the rest.
 */
const PATH_ATTRIBUTES = [
	"http.route",
	"next.route",
	"url.path",
	"http.target",
	"http.url",
	"url.full",
	"url.original",
] as const;

/**
 * Does this bag describe a probe? The one answer for a whole span, so the
 * sampler that refuses to create one and the processor that refuses to
 * forward one cannot disagree.
 */
export function isProbeAttributes(attributes: AttributeBag): boolean {
	return PATH_ATTRIBUTES.some((name) => {
		const value = attributes[name];
		return (
			typeof value === "string" && value !== "" && isProbePath(pathOf(value))
		);
	});
}

/**
 * Scrub a bag in place and report the route it ended up naming.
 *
 * In place because the caller is a span processor and the object it holds is
 * the one the exporter serialises later. The route comes back so the caller
 * can rename the span without redoing the work.
 */
export function scrubAttributes(attributes: AttributeBag): string | null {
	let route: string | null = null;

	const declared = attributes["http.route"];
	if (typeof declared === "string" && declared !== "") {
		route = redactPath(declared);
		attributes["http.route"] = route;
	}

	for (const name of URL_ATTRIBUTES) {
		const value = attributes[name];
		if (typeof value !== "string") continue;
		const scrubbed = scrubUrl(value);
		attributes[name] = scrubbed;
		route ??= routeOfScrubbed(scrubbed);
	}

	for (const name of TEXT_ATTRIBUTES) {
		const value = attributes[name];
		if (typeof value === "string") attributes[name] = scrubText(value);
	}

	for (const name of DROPPED_ATTRIBUTES) delete attributes[name];

	return route;
}
