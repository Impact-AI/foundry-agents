import { expect, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import type { Session } from "next-auth";
import { CSP_HEADER, contentSecurityPolicy, freshNonce } from "./csp";
import { answer } from "./door";

const directive = (csp: string | null, name: string) =>
	csp
		?.split(";")
		.map((d) => d.trim())
		.find((d) => d.startsWith(`${name} `));

const held = {
	user: { id: "a", name: "Ada" },
	expires: new Date(Date.now() + 60_000).toISOString(),
} as unknown as Session;

/** The nonce Next would read: the one in the request's copy of the header. */
const onwardPolicy = (response: Response) =>
	response.headers.get(`x-middleware-request-${CSP_HEADER.toLowerCase()}`);

test("a page's scripts run by this request's nonce alone: no inline allowance and no eval", () => {
	const restore = scopedEnv({ NODE_ENV: "production" });
	try {
		const response = answer(
			null,
			new URL("https://app.test/login"),
			new Headers(),
		);
		const policy = response.headers.get(CSP_HEADER);
		const script = directive(policy, "script-src");
		expect(script).toMatch(
			/^script-src 'self' 'nonce-[A-Za-z0-9+/=]{22,}' 'strict-dynamic'$/,
		);
		expect(script).not.toContain("unsafe-inline");
		expect(script).not.toContain("unsafe-eval");
		// The request carries the same policy on, so the page is rendered with the nonce the browser is told.
		expect(onwardPolicy(response)).toBe(policy);
	} finally {
		restore();
	}
});

test("every request is given a nonce no other had", () => {
	const seen = new Set<string>();
	for (let i = 0; i < 50; i++) {
		const policy = answer(
			null,
			new URL("https://app.test/login"),
			new Headers(),
		).headers.get(CSP_HEADER);
		seen.add(/'nonce-([^']+)'/.exec(policy ?? "")?.[1] ?? "");
	}
	expect(seen.size).toBe(50);
	expect(seen.has("")).toBe(false);
	expect(freshNonce()).not.toBe(freshNonce());
});

test("a redirect to the door carries the policy too", () => {
	const page = answer(null, new URL("https://app.test/chat"), new Headers());
	expect(page.status).toBe(307);
	expect(page.headers.get(CSP_HEADER)).toContain("'nonce-");
});

test("an endpoint's answer is not given the page's policy: its refusal, and what a session is let through to", () => {
	const refused = answer(
		null,
		new URL("https://app.test/api/me"),
		new Headers(),
	);
	expect(refused.status).toBe(401);
	expect(refused.headers.get(CSP_HEADER)).toBeNull();
	// A picture answers with a sandbox of its own, which the page's must not replace.
	const through = answer(
		held,
		new URL("https://app.test/api/media/library/cover"),
		new Headers(),
	);
	expect(through.headers.get(CSP_HEADER)).toBeNull();
	expect(onwardPolicy(through)).toBeNull();
});

test("a path that names a file is let through without a session, and whatever page answers it is rendered with the nonce", () => {
	for (const path of [
		"/nope.txt",
		"/foo/bar.html",
		"/voice/capture-worklet.js",
	]) {
		const response = answer(
			null,
			new URL(`https://app.test${path}`),
			new Headers(),
		);
		// Not the door: a file under public/ was never behind it.
		expect(response.status).toBe(200);
		const policy = response.headers.get(CSP_HEADER);
		expect(policy).toContain("'nonce-");
		expect(onwardPolicy(response)).toBe(policy);
	}
});

test("the proxy runs on every path that can answer with a page, and on no endpoint that names a file nor the public logo, which a shared cache keeps", async () => {
	const source = await Bun.file(`${import.meta.dir}/../proxy.ts`).text();
	const pattern = /matcher: \[\s*"([^"]+)"/.exec(source)?.[1];
	expect(pattern).toBeDefined();
	// The source is a string literal: its doubled backslashes are single in the pattern.
	const matcher = new RegExp(`^${pattern?.replaceAll("\\\\", "\\")}$`);
	for (const path of [
		"/chat",
		"/login",
		"/nope.txt",
		"/foo/bar.html",
		"/favicon.ico",
		"/api/me",
		"/api/media/library/cover",
		"/api/appearance/logos",
	])
		expect([path, matcher.test(path)]).toEqual([path, true]);
	for (const path of [
		"/api/auth/session",
		"/health",
		"/api/appearance/logo",
		"/_next/static/chunks/a.js",
		"/_next/image",
		"/api/media/library/cover.png",
	])
		expect([path, matcher.test(path)]).toEqual([path, false]);
});

test("a session that holds goes through with the nonce on the request", () => {
	const response = answer(
		held,
		new URL("https://app.test/chat"),
		new Headers({ cookie: "a=b" }),
	);
	expect(onwardPolicy(response)).toBe(response.headers.get(CSP_HEADER));
	expect(response.headers.get("x-middleware-request-cookie")).toBe("a=b");
});

test("development alone may eval, and without a nonce the policy admits this origin's files only", () => {
	expect(
		directive(contentSecurityPolicy({ nonce: "n", dev: true }), "script-src"),
	).toBe("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
	expect(directive(contentSecurityPolicy({ dev: false }), "script-src")).toBe(
		"script-src 'self'",
	);
});
