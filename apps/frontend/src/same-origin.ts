const HERE = "https://same-origin.invalid";

/**
 * Whether `url` is a path on this origin, read the way a browser reads it.
 * A prefix test is not that: a browser takes `\` for `/` and drops tabs and
 * newlines, so `/\host/x` and `/\t/host/x` both name another host. Parsing
 * against a placeholder origin and comparing origins is the check that
 * agrees with the browser.
 */
export function isSameOriginPath(url: string): boolean {
	if (!url.startsWith("/")) return false;
	try {
		return new URL(url, HERE).origin === HERE;
	} catch {
		return false;
	}
}

/** Where the backend's pictures are served on this origin. */
const MEDIA_PREFIX = "/api/media/";

/**
 * Whether `url` is a picture's path on this origin: the media route and
 * nothing else. A `src` is a request the browser makes with the session, so
 * text the model wrote may name a picture and no other route.
 */
export function isMediaPath(url: string): boolean {
	if (!isSameOriginPath(url)) return false;
	return new URL(url, HERE).pathname.startsWith(MEDIA_PREFIX);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether `origin` — what a browser says composed a request — is `own`, the
 * origin this app's pages are served from: scheme, host and port, each
 * compared, as a browser compares them. The one test for a request that
 * changes something and for the live socket's upgrade.
 */
export function isOwnOrigin(origin: string, own: string | null): boolean {
	if (!own) return false;
	try {
		return new URL(origin).origin === new URL(own).origin;
	} catch {
		return false;
	}
}

/** The first of a forwarded header's values: the one the edge wrote. */
const first = (value: string | null) => value?.split(",")[0]?.trim() || null;

/**
 * The origin a page of this app is served from: `AUTH_URL`'s where the
 * deployment names it, else what the request says it was addressed to —
 * the forwarded host and scheme behind a proxy, its own otherwise. A proxy
 * that names the host and not the scheme is taken to end TLS, as one in
 * front of a deployment does: the request it sends on is plain, and reading
 * its scheme would refuse every write a page there makes.
 */
function ownOrigin(req: Request): string | null {
	if (process.env.AUTH_URL) return process.env.AUTH_URL;
	const forwarded = first(req.headers.get("x-forwarded-host"));
	const host = forwarded ?? first(req.headers.get("host"));
	if (!host) return null;
	const scheme =
		first(req.headers.get("x-forwarded-proto")) ??
		(forwarded ? "https" : new URL(req.url).protocol.replace(":", ""));
	return `${scheme}://${host}`;
}

/**
 * Whether a request that changes something came from a page of this app.
 * The session cookie rides on a request from any site, so the cookie alone
 * does not say who composed it; the browser does, in `Sec-Fetch-Site` and in
 * `Origin`, neither of which a page's script can set. A browser sends
 * `Origin` on every request that is not a GET or a HEAD, so a request with
 * neither header was not composed by a page at all — a script holding the
 * cookie itself — and is let through. A read is never refused here.
 */
export function isOwnOriginRequest(req: Request): boolean {
	if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
	const site = req.headers.get("sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none") return false;
	const origin = req.headers.get("origin");
	if (!origin) return true;
	return isOwnOrigin(origin, ownOrigin(req));
}
