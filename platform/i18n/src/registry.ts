/**
 * The product's languages, as one validated registry that every resolver
 * takes as its first argument. The list is the product's; this package ships
 * English only as its default and never a list of its own.
 */

export interface LocaleEntry<L extends string = string> {
	/**
	 * A bare language subtag — `fr`, not `fr-CH` — so every code is also an
	 * ISO-639 code that speech-to-text accepts as its `language` with no
	 * mapping table in between.
	 */
	code: L;
	/** The endonym, for a person picking from a menu: `Français`. */
	label: string;
	/**
	 * The English name, for a model: `French`. A model follows "Speak French"
	 * far more reliably than `fr`, and an endonym is a coin flip.
	 */
	languageName: string;
	/**
	 * The BCP-47 locale a voice speaks this language with — `fr-FR`, not
	 * `fr-CA` — for a speech engine that takes a language and an accent
	 * apart. Absent, a voice picks its own accent for the language.
	 */
	accent?: string;
}

export interface LocalesConfig<L extends string> {
	/** In menu order. */
	supported: readonly LocaleEntry<L>[];
	/** The last resort when nothing else answers. The first entry when omitted. */
	default?: L;
	/** The cookie a stated choice is persisted in. */
	cookieName?: string;
}

export interface LocaleRegistry<L extends string = string> {
	readonly codes: readonly L[];
	readonly defaultLocale: L;
	readonly cookieName: string;
	isLocale(value: unknown): value is L;
	label(locale: L): string;
	languageName(locale: L): string;
	/** The accent a voice speaks it with; null when the product names none. */
	accent(locale: L): string | null;
}

/** The de-facto name Next's tooling looks for. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export const ENGLISH: LocaleEntry<"en"> = {
	code: "en",
	label: "English",
	languageName: "English",
	accent: "en-US",
};

const BARE_SUBTAG = /^[a-z]{2,3}$/;
/** A language and a region, the shape every speech locale takes: `fr-FR`. */
const ACCENT = /^([a-z]{2,3})-[A-Z]{2}$/;

/** A configuration error, found at definition rather than on a request. */
export class LocaleConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocaleConfigError";
	}
}

export function defineLocales(): LocaleRegistry<"en">;
export function defineLocales<const L extends string>(
	config: LocalesConfig<L>,
): LocaleRegistry<L>;
export function defineLocales<const L extends string>(
	config: LocalesConfig<L> = { supported: [ENGLISH as LocaleEntry<L>] },
): LocaleRegistry<L> {
	const entries = new Map<L, LocaleEntry<L>>();
	for (const entry of config.supported) {
		if (!BARE_SUBTAG.test(entry.code))
			throw new LocaleConfigError(
				`locale "${entry.code}" is not a bare lowercase language subtag`,
			);
		if (entries.has(entry.code))
			throw new LocaleConfigError(`locale "${entry.code}" is listed twice`);
		if (!entry.label.trim() || !entry.languageName.trim())
			throw new LocaleConfigError(
				`locale "${entry.code}" needs both a label and an English language name`,
			);
		if (
			entry.accent !== undefined &&
			ACCENT.exec(entry.accent)?.[1] !== entry.code
		)
			throw new LocaleConfigError(
				`locale "${entry.code}" has the accent "${entry.accent}": a region of its own language, like "${entry.code}-${entry.code.toUpperCase()}"`,
			);
		entries.set(entry.code, entry);
	}
	const codes = [...entries.keys()];
	const first = codes[0];
	if (first === undefined)
		throw new LocaleConfigError("a registry needs at least one locale");
	const defaultLocale = config.default ?? first;
	if (!entries.has(defaultLocale))
		throw new LocaleConfigError(
			`default locale "${defaultLocale}" is not among the supported ones`,
		);

	const entryOf = (locale: L): LocaleEntry<L> => {
		const entry = entries.get(locale);
		if (!entry)
			throw new LocaleConfigError(`locale "${locale}" is not supported`);
		return entry;
	};

	return {
		codes,
		defaultLocale,
		cookieName: config.cookieName ?? LOCALE_COOKIE,
		isLocale: (value): value is L =>
			typeof value === "string" && entries.has(value as L),
		label: (locale) => entryOf(locale).label,
		languageName: (locale) => entryOf(locale).languageName,
		accent: (locale) => entryOf(locale).accent ?? null,
	};
}
