/**
 * A stored document merged over a default, leaf by leaf, by the default's
 * shape — the parser every settings document shares.
 *
 * A stored leaf is kept only when it passes the rule for its path, so a hand
 * edit in the store can tighten or widen a bound and never remove one:
 * nothing here produces a zero, an "unlimited", or a missing field. The rule
 * is the default's kind: a string, a boolean, or a finite positive number.
 * A path whose rule is different — zero allowed, an integer wanted, a
 * window, a closed list — names it in `accept`. A section that is not an
 * object, and a key the default does not have, are ignored. `refused`
 * collects the paths of stored leaves that were ignored, for the caller to
 * say so once.
 */

/** Whether a stored leaf may stand in for the default's. */
export type LeafRule = (value: unknown, fallback: unknown) => boolean;

export interface MergeOptions {
	/** The rule for a leaf, by its dotted path, where the default rule is not the right one. */
	accept?: Record<string, LeafRule>;
	/** The rule for every number without an entry in `accept`: finite and positive unless given. */
	numbers?: LeafRule;
	/** Filled with the paths of stored leaves that were refused. */
	refused?: string[];
}

export function mergeOverDefault<T extends object>(
	stored: unknown,
	defaults: T,
	options: MergeOptions = {},
): T {
	return walk(stored, defaults, options, "");
}

function walk<T extends object>(
	stored: unknown,
	defaults: T,
	options: MergeOptions,
	path: string,
): T {
	const given = isRecord(stored) ? stored : {};
	const merged = {} as Record<string, unknown>;
	for (const [key, fallback] of Object.entries(defaults)) {
		const here = path ? `${path}.${key}` : key;
		const value = given[key];
		if (isRecord(fallback)) {
			merged[key] = walk(value, fallback, options, here);
		} else if (value === undefined) {
			merged[key] = fallback;
		} else if (ruleFor(here, fallback, options)(value, fallback)) {
			merged[key] = value;
		} else {
			options.refused?.push(here);
			merged[key] = fallback;
		}
	}
	return merged as T;
}

function ruleFor(
	path: string,
	fallback: unknown,
	options: MergeOptions,
): LeafRule {
	const named = options.accept?.[path];
	if (named) return named;
	if (typeof fallback === "number") return options.numbers ?? positiveNumber;
	return sameKind;
}

/** The default's kind: a finite positive number, a boolean, or a string. */
export const sameKind: LeafRule = (value, fallback) => {
	if (typeof value !== typeof fallback) return false;
	if (typeof value === "number") return positiveNumber(value);
	return typeof value === "boolean" || typeof value === "string";
};

export function positiveNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A bound can be moved, never removed. */
export function positiveInteger(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) > 0;
}

/** Zero allowed: no delay is a legitimate setting, no bound is not. */
export function nonNegativeInteger(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) >= 0;
}

/** A finite number no smaller than `min`. */
export function atLeast(min: number): LeafRule {
	return (value) =>
		typeof value === "number" && Number.isFinite(value) && value >= min;
}

/** A whole number inside a window; outside it the stored value is a typo. */
export function integerBetween(min: number, max: number): LeafRule {
	return (value) =>
		Number.isInteger(value) &&
		(value as number) >= min &&
		(value as number) <= max;
}

/** A finite number inside a window, bounds included. */
export function numberBetween(min: number, max: number): LeafRule {
	return (value) =>
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= max;
}

/** A list of strings, empty included: a vocabulary an operator may clear. */
export const stringList: LeafRule = (value) =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/** One of a closed list of strings. */
export function oneOf<V extends string>(values: readonly V[]): LeafRule {
	return (value) => (values as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
