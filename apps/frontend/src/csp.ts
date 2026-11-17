/**
 * The page's Content Security Policy, in one place for the two that send
 * it. The proxy sends it with a nonce, fresh for each request, on every
 * path that can answer with a document — every page, the not-found page
 * of a path nothing serves included: Next reads the nonce off the
 * request's copy of the header and puts it on the inline scripts it
 * writes, and `'strict-dynamic'` lets those load the bundles, so an inline
 * script without the nonce does not run. `next.config.ts` sends it without
 * one on the rest (Next's own files, Auth.js's routes, the endpoints),
 * where no page's script is written.
 *
 * Nothing loads from another origin: every picture comes through
 * `/api/media/`, and the browser talks to this app alone — the live voice
 * is a WebSocket to this origin ('self' covers ws/wss to the same host),
 * and its worklets are this origin's scripts. So a URL in model-written
 * text has no host to reach. Styles keep 'unsafe-inline': React writes
 * `style` attributes, which a nonce cannot carry.
 */
export function contentSecurityPolicy(options: {
	nonce?: string;
	dev: boolean;
}): string {
	const { nonce, dev } = options;
	// React rebuilds server error stacks with eval in development only.
	const script = [
		"script-src 'self'",
		...(nonce ? [`'nonce-${nonce}'`, "'strict-dynamic'"] : []),
		...(dev ? ["'unsafe-eval'"] : []),
	].join(" ");
	return [
		"default-src 'self'",
		script,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"media-src 'self' data: blob:",
		"font-src 'self' data:",
		`connect-src 'self'${dev ? " ws:" : ""}`,
		"worker-src 'self' blob:",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

export const CSP_HEADER = "Content-Security-Policy";

/** A nonce no page before this one was given: 128 random bits. */
export function freshNonce(): string {
	return btoa(
		String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
	);
}
