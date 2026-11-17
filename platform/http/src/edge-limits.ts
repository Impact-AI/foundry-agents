import {
	type ConfigKey,
	defineConfigKey,
	integerBetween,
	type MergeOptions,
	mergeOverDefault,
	processSingleton,
} from "@platform/config";

/**
 * What the edge in front of this deployment will accept, as a thing an
 * operator changes without a deploy.
 *
 * The edge refuses a request body over its limit with its own 403, in a
 * request that never reaches a container, so nothing on this side logs why.
 * The limit is a fact about the edge, not about this code. Set it to what a
 * measurement against the live edge says, not to what a request for a change
 * asked for.
 */
export interface EdgeLimits {
	/** The most a request body may weigh on the wire, in bytes. */
	maxRequestBodyBytes: number;
}

/**
 * One mebibyte when no store says otherwise: room for a chat run that carries
 * a long thread and a downscaled picture. With nothing in front of the
 * Container Apps ingress this is the only bound; behind a web application
 * firewall that inspects bodies up to a limit of its own, an operator sets
 * the document to that limit.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;

export const DEFAULT_EDGE_LIMITS: EdgeLimits = {
	maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
};

/**
 * The window a stored value is believed inside. Outside it the value is a
 * typo — a missing `000`, or kilobytes where bytes were asked for — and the
 * default is served, because a portal edit must not be able to stop every
 * request with a body. There is no value here that reads as "no limit".
 */
const MIN_BODY_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const ACCEPT: MergeOptions["accept"] = {
	maxRequestBodyBytes: integerBetween(MIN_BODY_BYTES, MAX_BODY_BYTES),
};

export function edgeLimitsFromStored(
	stored: unknown,
	defaults: EdgeLimits = DEFAULT_EDGE_LIMITS,
): EdgeLimits {
	const refused: string[] = [];
	const limits = mergeOverDefault(stored, defaults, {
		accept: ACCEPT,
		refused,
	});
	if (refused.length > 0) {
		const value = (stored as Record<string, unknown>).maxRequestBodyBytes;
		console.error(
			`[edge] ignoring maxRequestBodyBytes=${String(value)} — expected a whole number of bytes between ${MIN_BODY_BYTES} and ${MAX_BODY_BYTES}; serving ${defaults.maxRequestBodyBytes}`,
		);
	}
	return limits;
}

/** The stored document `edge`; memoised per process, fail-soft, never zero. */
export function edgeLimits(): ConfigKey<EdgeLimits> {
	return processSingleton("edge:limits", () =>
		defineConfigKey<EdgeLimits>({
			key: "edge",
			defaultValue: DEFAULT_EDGE_LIMITS,
			parse: edgeLimitsFromStored,
		}),
	);
}
