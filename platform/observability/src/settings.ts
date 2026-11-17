import {
	type ConfigKey,
	defineConfigKey,
	envString,
	type MergeOptions,
	mergeOverDefault,
	processSingleton,
} from "@platform/config";

/**
 * Whether telemetry runs at all, and the one number an operator changes while
 * an incident is happening.
 *
 * Two kinds of setting in two places. The connection string is bootstrap: it
 * names the resource and carries its ingestion key, so it is a secret
 * reference in the environment, and it is the on/off switch — absent, nothing
 * starts, nothing is exported, nothing complains. It is bootstrap rather than
 * a stored key because an SDK that has started runs until the process ends;
 * a key that appeared to turn telemetry off and did not would be worse than a
 * variable that says plainly it takes a revision. The sampling ratio is
 * tunable: a portal edit live inside `@platform/config`'s memo pace, with no
 * restart.
 */

export const CONNECTION_STRING_VAR = "APPLICATIONINSIGHTS_CONNECTION_STRING";

/** The bare key in the store; the configured prefix is added on the read. */
export const TELEMETRY_CONFIG_KEY = "telemetry";

export interface TelemetrySettings {
	/**
	 * The fraction of traces recorded, `0 < ratio <= 1`. Not zero: a ratio of
	 * zero is indistinguishable from a broken exporter, and the way to record
	 * nothing is to unset the connection string.
	 */
	samplingRatio: number;
}

export const DEFAULT_TELEMETRY: TelemetrySettings = { samplingRatio: 1 };

export function connectionString(): string | undefined {
	return envString(CONNECTION_STRING_VAR);
}

/** The one gate every entry point asks. */
export function telemetryConfigured(): boolean {
	return connectionString() !== undefined;
}

/**
 * A ratio outside `(0, 1]` is refused rather than clamped: clamping `-1` to
 * `0` would silently stop recording, and clamping `50` to `1` would hide a
 * typo the operator needs to see.
 */
const ACCEPT: MergeOptions["accept"] = {
	samplingRatio: (value) =>
		typeof value === "number" && value > 0 && value <= 1,
};

/** The stored document merged over the defaults, field by field. */
export function fromStored(
	stored: unknown,
	defaults: TelemetrySettings,
): TelemetrySettings {
	return mergeOverDefault(stored, defaults, { accept: ACCEPT });
}

/** The stored document `telemetry`; memoised per process, fail-soft. */
export function telemetrySettings(): ConfigKey<TelemetrySettings> {
	return processSingleton("telemetry:settings", () =>
		defineConfigKey({
			key: TELEMETRY_CONFIG_KEY,
			defaultValue: DEFAULT_TELEMETRY,
			parse: fromStored,
		}),
	);
}
