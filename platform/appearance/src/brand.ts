/**
 * What the app is called, the line it greets a person with, and its logo:
 * per deployment, the name and the line per language.
 *
 * An empty string is "the catalogue's": the app's own name and heading in
 * that language, so a deployment that sets nothing reads exactly as shipped.
 * Text is drawn as text — React escapes it — so the rules here are about
 * length and about characters that have no business in a title.
 *
 * ## The logo
 *
 * An object in the deployment's appearance container, named for its bytes:
 * `appearance/logo/<sha256>.<ext>`. The document holds that key — the hash
 * is its version, so a new logo is a new address and no cache serves the
 * old one. Whoever writes one checks its bytes first; only the backend's
 * `GET /appearance/logo` reads one, and only the key the document names.
 *
 * Raster only: PNG, JPEG, GIF or WebP, whose decoders run no script. SVG is
 * a document that can carry script, and no key names one.
 */

const NAME_MAX = 60;
const WELCOME_MAX = 160;
/** The largest logo the backend serves. */
export const LOGO_MAX_BYTES = 512 * 1024;

const LOGO_KEY = /^appearance\/logo\/([0-9a-f]{64})\.(png|jpg|webp|gif)$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function text(max: number) {
	return (value: unknown): boolean =>
		typeof value === "string" &&
		value.length <= max &&
		value.trim() === value &&
		!CONTROL.test(value);
}

/** A name in one language: empty for the catalogue's, else at most 60 characters on one line. */
export const isName = text(NAME_MAX);
/** A welcome line in one language: empty for the catalogue's, else at most 160 characters on one line. */
export const isWelcome = text(WELCOME_MAX);

const LOGO_EXTENSIONS = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
} as const;

export type LogoType = (typeof LOGO_EXTENSIONS)[keyof typeof LOGO_EXTENSIONS];

/** The content types a logo may be served as. */
export const LOGO_TYPES: readonly LogoType[] = Object.values(LOGO_EXTENSIONS);

/** Empty (no logo), or a key under the logo's prefix, named for its bytes. */
export function isLogoKey(value: unknown): boolean {
	return value === "" || (typeof value === "string" && LOGO_KEY.test(value));
}

/** The type a logo key's extension names: what the stored object must be. */
export function logoKeyType(key: string): LogoType | null {
	const ext = LOGO_KEY.exec(key)?.[2] as keyof typeof LOGO_EXTENSIONS;
	return ext ? LOGO_EXTENSIONS[ext] : null;
}

/** A short version of the logo, for an address that changes when it does. */
export function logoVersion(key: string): string {
	return LOGO_KEY.exec(key)?.[1]?.slice(0, 16) ?? "";
}
