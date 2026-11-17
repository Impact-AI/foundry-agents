import { envString } from "@platform/config/env";

/**
 * The one compact signed token: `base64url(JSON payload).base64url(HMAC-SHA256)`.
 *
 * Every purpose derives its own key from a shared secret under a label, so
 * the same secret signs two purposes' tokens without either verifying as
 * the other. The label is versioned by its owner: a change to a
 * payload's meaning changes it, and every token minted before stops
 * verifying. `crypto.subtle` only, so a web app's edge route and a Bun
 * service share the code.
 */

const encoder = new TextEncoder();

interface DerivedKey {
	/** The secret the key was derived from, so a rotated secret re-derives rather than verifies stale. */
	secret: string;
	key: Promise<CryptoKey>;
}

/** Keyed on the variable and the label, never on the secret itself. */
const derived = new Map<string, DerivedKey>();

/** Throws rather than falling back: a token signed with nothing is worse than a refusal. */
function requireSecret(secretVar: string): string {
	const secret = envString(secretVar);
	if (!secret)
		throw new Error(`${secretVar} is not set; nothing can sign a token.`);
	return secret;
}

/** HMAC the label under the secret for 32 bytes of key material, then import that as the signing key. */
export function labelledKey(
	secretVar: string,
	label: string,
): Promise<CryptoKey> {
	const secret = requireSecret(secretVar);
	const cacheKey = `${secretVar}\u0000${label}`;
	const cached = derived.get(cacheKey);
	if (cached && cached.secret === secret) return cached.key;
	const key = deriveKey(secret, label);
	derived.set(cacheKey, { secret, key });
	return key;
}

async function deriveKey(secret: string, label: string): Promise<CryptoKey> {
	const root = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const material = await crypto.subtle.sign(
		"HMAC",
		root,
		encoder.encode(label),
	);
	return crypto.subtle.importKey(
		"raw",
		material,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signCompact(
	payload: object,
	secretVar: string,
	label: string,
): Promise<string> {
	const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign(
		"HMAC",
		await labelledKey(secretVar, label),
		encoder.encode(body),
	);
	return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The object `token` carries, or null unless its signature verifies under `label`'s key. */
export async function verifyCompact(
	token: string,
	secretVar: string,
	label: string,
): Promise<Record<string, unknown> | null> {
	const [body, signature, ...rest] = token.split(".");
	if (!body || !signature || rest.length > 0) return null;
	try {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await labelledKey(secretVar, label),
			base64UrlDecode(signature),
			encoder.encode(body),
		);
		if (!valid) return null;
		const payload: unknown = JSON.parse(
			new TextDecoder().decode(base64UrlDecode(body)),
		);
		return payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** ArrayBuffer-backed on purpose: `crypto.subtle` refuses a SharedArrayBuffer view. */
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
