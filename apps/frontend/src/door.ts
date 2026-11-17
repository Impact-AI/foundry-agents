import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { holdsSession, isPublicPath } from "../auth.config";
import { CSP_HEADER, contentSecurityPolicy, freshNonce } from "./csp";

/**
 * What the proxy answers a request with: through, for a session that holds
 * or a public path; otherwise a status for an endpoint — a fetch that
 * follows a redirect to the door reads HTML where it expected JSON — and the
 * door for a page, remembering where the person was going. A session that
 * no longer holds (`holdsSession`) is nobody here, as it is on every page.
 * `through` is how a request goes on, for a caller that sends it on with
 * headers of its own.
 */
export function door(
	session: Session | null,
	url: Pick<URL, "pathname" | "search" | "href">,
	through: () => NextResponse = () => NextResponse.next(),
): NextResponse {
	if (holdsSession(session) || isPublicPath(url.pathname)) return through();
	if (url.pathname.startsWith("/api/"))
		return NextResponse.json({ code: "unauthenticated" }, { status: 401 });
	const login = new URL("/login", url.href);
	login.searchParams.set("callbackUrl", url.pathname + url.search);
	return NextResponse.redirect(login);
}

/**
 * A path whose last segment has a dot in it, outside `/api/`: a file, by
 * its name. It is a file under `public/`, which the door never stood
 * before, or it is nothing.
 */
export const namesFile = (pathname: string): boolean =>
	!pathname.startsWith("/api/") && /\.[^/]+$/.test(pathname);

/** The page's policy with a nonce of this request's. */
const policyNow = (): string =>
	contentSecurityPolicy({
		nonce: freshNonce(),
		dev: process.env.NODE_ENV === "development",
	});

/** The request sent on with `policy` on it and on its answer: Next takes the nonce for the inline scripts it writes from the request's copy. */
function onward(headers: Headers, policy: string): NextResponse {
	const carried = new Headers(headers);
	carried.set(CSP_HEADER, policy);
	const response = NextResponse.next({ request: { headers: carried } });
	response.headers.set(CSP_HEADER, policy);
	return response;
}

/**
 * What a path that names a file is answered with: let through whoever asks,
 * with the policy the not-found page needs if that is what it turns out to
 * be. No session is read for it, so the answer sets no cookie: a file under
 * `public/` is the same bytes for everybody and may be kept by a cache that
 * serves everybody.
 */
export function fileAnswer(headers: Headers): NextResponse {
	return onward(headers, policyNow());
}

/**
 * The door, and the page's policy with this request's nonce. The policy
 * goes on the request as well as the answer: Next takes the nonce for the
 * inline scripts it writes from the request's copy. Every answer that can
 * be a document carries it, a redirect to the door included.
 *
 * An endpoint's answer is left alone: it is no document, and one that sets
 * a policy of its own — a picture's sandbox — must not have the page's
 * laid over it. A path that names a file is answered as `fileAnswer` does,
 * for a caller that has read the session all the same.
 */
export function answer(
	session: Parameters<typeof door>[0],
	url: Parameters<typeof door>[1],
	headers: Headers,
): NextResponse {
	if (url.pathname.startsWith("/api/")) return door(session, url);
	if (namesFile(url.pathname)) return fileAnswer(headers);
	const policy = policyNow();
	const response = door(session, url, () => onward(headers, policy));
	response.headers.set(CSP_HEADER, policy);
	return response;
}
