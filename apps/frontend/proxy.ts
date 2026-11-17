import type { NextFetchEvent, NextRequest } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { answer, fileAnswer, namesFile } from "./src/door";

// Next 16 calls this Proxy, and the file must be `proxy.ts` with a default
// export; Auth.js's `export { auth as middleware }` is not picked up.
const { auth } = NextAuth(authConfig());

const behindTheDoor = auth((req) => answer(req.auth, req.nextUrl, req.headers));

// A path that names a file is never asked for its session: Auth.js writes
// the session's cookie onto whatever it answers, and a file under `public/`
// is answered to everybody alike.
export default function proxy(request: NextRequest, event: NextFetchEvent) {
	if (namesFile(request.nextUrl.pathname)) return fileAnswer(request.headers);
	return behindTheDoor(request, event as never);
}

export const config = {
	// Everything except Auth.js routes, the platform's health probe, the
	// deployment's logo, Next internals and an endpoint whose last segment has
	// a dot in it. The first three stop at a segment boundary. The logo is
	// public and kept by shared caches (`Cache-Control: public`), and Auth.js
	// writes its cookies onto whatever passes through it, so the logo must
	// not: a cookie on an answer a cache keeps is handed to everybody. A route under `app/api` whose
	// last segment can carry a dot — a picture's path — is therefore not
	// behind this door, which is why every handler there reads the session
	// itself (`withCaller`), and `app/api/routes.test.ts` holds each one to
	// it. Any other path with a dot comes here for its policy and is let
	// through without a session (`answer`): it is a file under `public/`, or
	// nothing, and the page that says so writes scripts like any other.
	matcher: [
		"/((?!api/auth(?:/|$)|health(?:/|$)|api/appearance/logo(?:/|$)|_next/static|_next/image|api/.*\\.[^/]+$).*)",
	],
};
