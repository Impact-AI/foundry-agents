import {
	type ConfigKey,
	defineConfigKey,
	processSingleton,
} from "@platform/config";
import {
	APPEARANCE_CONFIG_KEY,
	type AppearanceSettings,
	appearanceDefaults,
	parseAppearance,
} from "./document";

/**
 * The stored `appearance` document for a product's languages, memoised per
 * process and fail-soft: an unreadable store serves the last good value, or
 * the shipped look before the first read. Server-only — it reaches App
 * Configuration.
 */
export function appearanceSettings(
	locales: readonly string[],
): ConfigKey<AppearanceSettings> {
	return processSingleton(`appearance:settings:${locales.join(",")}`, () =>
		defineConfigKey({
			key: APPEARANCE_CONFIG_KEY,
			defaultValue: appearanceDefaults(locales),
			parse: (stored, defaults) => {
				const refused: string[] = [];
				const value = parseAppearance(stored, defaults, refused);
				const unreadable = refused.some((path) => /^palette\.\w+$/.test(path));
				if (refused.length)
					console.warn(
						`[appearance] ignoring stored ${refused.join(", ")}: each keeps its shipped value${unreadable ? " (a palette is refused whole when any text on it would read below WCAG AA)" : ""}`,
					);
				return value;
			},
		}),
	);
}
