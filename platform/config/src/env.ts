/**
 * Typed reads of environment variables.
 *
 * `Number(process.env.X ?? 2)` has a failure mode nothing reports: `X=abc` is
 * `NaN`, and `NaN` compares false against everything, so a concurrency cap
 * admits every caller and a deadline never fires. A failed read here falls
 * back to the compiled-in default and warns once, never to unlimited.
 */

export interface IntRange {
	/** Smallest acceptable value, inclusive. */
	min?: number;
	/** Largest acceptable value, inclusive. */
	max?: number;
}

const warned = new Set<string>();

/** The integer `name` holds, or `fallback` when unset, blank, non-integer or out of range. */
export function envInt(
	name: string,
	fallback: number,
	{ min, max }: IntRange = {},
): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	// Decimal digits only: `Number` also reads "0x10" and "1e3", which nobody
	// setting a count or a timeout means.
	const value = /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
	const inRange =
		Number.isInteger(value) &&
		(min === undefined || value >= min) &&
		(max === undefined || value <= max);
	if (inRange) return value;
	if (!warned.has(name)) {
		warned.add(name);
		console.warn(
			`${name}: "${raw}" is not ${describeRange(min, max)} — using ${fallback}.`,
		);
	}
	return fallback;
}

/** The trimmed value of `name`, or `undefined` when unset or blank. */
export function envString(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

const OFF = new Set(["0", "false", "no", "off"]);

/**
 * A toggle's value, read the one way. Unset or blank is `whenUnset`, so a
 * template that renders an unset parameter as "" leaves the default alone;
 * only the explicit off-values are off, and any other value is on, so a
 * misspelled "yes" cannot read as "no".
 */
export function isOn(raw: string | undefined, whenUnset = false): boolean {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "") return whenUnset;
	return !OFF.has(value);
}

/** Whether the toggle `name` is on; `whenUnset` answers for a variable nobody set. */
export function envFlag(name: string, whenUnset = false): boolean {
	return isOn(process.env[name], whenUnset);
}

/**
 * A deploy-time choice of component (`MEMORY_STORE`, `RETRIEVAL_ENGINE`, …):
 * the variable's value when it is one of `allowed`, otherwise undefined, so
 * the caller's own default answers. An unknown value is refused before
 * provisioning (`hooks/preprovision.sh`) and by the migrate job, never here.
 */
export function envChoice<T extends string>(
	name: string,
	allowed: readonly T[],
): T | undefined {
	const value = (process.env[name] ?? "").trim();
	return (allowed as readonly string[]).includes(value)
		? (value as T)
		: undefined;
}

export const DEFAULT_CONFIG_TTL_MS = 30_000;

/**
 * How long a stored document is served from memory before the store is asked
 * again: one pace for every memo, so a portal edit lands everywhere inside
 * the same window. A definition pins a different pace in code when its
 * document moves at a different speed.
 */
export function configTtlMs(): number {
	return envInt("CONFIG_TTL_MS", DEFAULT_CONFIG_TTL_MS, { min: 1 });
}

function describeRange(min?: number, max?: number): string {
	if (min !== undefined && max !== undefined)
		return `an integer between ${min} and ${max}`;
	if (min !== undefined) return `an integer of at least ${min}`;
	if (max !== undefined) return `an integer of at most ${max}`;
	return "an integer";
}
