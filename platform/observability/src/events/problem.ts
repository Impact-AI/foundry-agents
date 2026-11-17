import { defineEventChannel } from "./channel";

/**
 * A refusal, in a form a query can group by.
 *
 * A handled 4xx is a response, not an exception, so nothing records it unless
 * something does so on purpose. This channel carries a code and typed facets
 * and never a sentence: the facets are a closed interface, so a `detail` or a
 * `message` field is a type error rather than a leak, and every string facet
 * is held to one bare token at runtime. The product supplies its own closed
 * list of codes through {@link defineProblemCodes}; a caller that can spell a
 * new code on the fly is a caller that can spell a sentence.
 *
 * Nothing in a facet may identify a person: no subject, no email, no thread
 * id, no URL. A facet that must correlate one caller's refusals carries
 * `stableTag(id)` and is named `…_tag`.
 */

/** The event name, on stdout and on the span alike. */
export const PROBLEM_EVENT = "problem";

/** The prefix every attribute carries, so nothing collides with a span's own. */
export const ATTRIBUTE_PREFIX = "problem.";

/** What a string facet is replaced with when it is not a bare token. */
export const UNSAFE_VALUE = ":unsafe";

/** `area[.phase].reason`, lowercase, `_` inside a segment. */
export const PROBLEM_CODE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * What may be said about a refusal beyond which one it was. Every field is
 * something to filter or group by; none is prose and none is an identifier.
 */
export interface ProblemFacets {
	/** Which surface or route family refused. */
	surface?: string;
	/** The HTTP status the caller was answered with. */
	status?: number;
	/** Which of several ways this code can be reached — a bare token. */
	reason?: string;
	/** Which allowance ran out. */
	bucket?: string;
	/** Which bound was hit, where a code has more than one. */
	bound?: string;
	/** The tier the caller was resolved to. */
	tier?: string;
	/** The kind of caller — never who. */
	caller?: string;
	/** What was measured when a bound refused it. */
	measured?: number;
	/** The bound it was measured against. */
	limit?: number;
	/** Seconds the caller was told to wait, as the `Retry-After` says it. */
	retryAfterSeconds?: number;
}

/** The line as written to stdout and handed to the sink: one bag, one spelling. */
export interface ProblemLine {
	evt: typeof PROBLEM_EVENT;
	ts: string;
	attributes: Record<string, string | number>;
}

/**
 * No space, so prose cannot pass; no `@`, so an address cannot. A bound on
 * prose, not on identifiers — a pseudonym is a bare token and would pass,
 * which is why the rule on {@link ProblemFacets} exists.
 */
const SAFE_VALUE = /^[A-Za-z0-9_.:/-]{1,64}$/;

const FACET_ATTRIBUTES: Record<keyof ProblemFacets, string> = {
	surface: "surface",
	status: "status",
	reason: "reason",
	bucket: "bucket",
	bound: "bound",
	tier: "tier",
	caller: "caller",
	measured: "measured",
	limit: "limit",
	retryAfterSeconds: "retry_after_s",
};

/**
 * The attribute bag for one report. An absent facet stays absent rather than
 * becoming `""` or `0`: an absent attribute is queryable as absent, and a zero
 * is a measurement. A non-finite number is dropped for the same reason.
 */
export function problemAttributes(
	code: string,
	facets: ProblemFacets = {},
): Record<string, string | number> {
	const attributes: Record<string, string | number> = {
		[`${ATTRIBUTE_PREFIX}code`]: code,
	};
	for (const [facet, suffix] of Object.entries(FACET_ATTRIBUTES)) {
		const value = facets[facet as keyof ProblemFacets];
		if (value === undefined || value === null) continue;
		const name = `${ATTRIBUTE_PREFIX}${suffix}`;
		if (typeof value === "number") {
			if (Number.isFinite(value)) attributes[name] = value;
		} else {
			attributes[name] = SAFE_VALUE.test(value) ? value : UNSAFE_VALUE;
		}
	}
	return attributes;
}

export const problemChannel = defineEventChannel<ProblemLine>({
	event: PROBLEM_EVENT,
	switchVar: "PROBLEM_LOG",
	// Flat on stdout, so a query reads `problem.code` at the top level; the
	// sink gets the same bag under `attributes`, which is what a span takes.
	printed: (line) => ({ evt: line.evt, ts: line.ts, ...line.attributes }),
});

export interface ProblemReporter<C extends string> {
	readonly codes: readonly C[];
	/** Report one refusal. Never throws, never returns a failure. */
	report(code: C, facets?: ProblemFacets): void;
}

/**
 * The product's vocabulary, checked once at definition: every code has the
 * shape and none repeats. Returns the reporter whose `code` parameter is that
 * closed set.
 */
export function defineProblemCodes<const C extends string>(
	codes: readonly C[],
): ProblemReporter<C> {
	const seen = new Set<string>();
	for (const code of codes) {
		if (!PROBLEM_CODE_SHAPE.test(code))
			throw new Error(
				`problem code "${code}" is not area[.phase].reason in lowercase`,
			);
		if (seen.has(code))
			throw new Error(`problem code "${code}" is listed twice`);
		seen.add(code);
	}
	return {
		codes,
		report(code, facets) {
			problemChannel.emit({
				evt: PROBLEM_EVENT,
				ts: new Date().toISOString(),
				attributes: problemAttributes(code, facets),
			});
		},
	};
}
