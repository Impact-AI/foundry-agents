import { expect, test } from "bun:test";
import loadCustomRoutes from "next/dist/lib/load-custom-routes";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import config from "./next.config";

/**
 * The response headers as Next applies them: every rule whose source
 * matches, the first to set a header keeping it — and a route that sets one
 * already set here is ignored, so what this config sets is what is sent.
 */
async function headersFor(path: string): Promise<Map<string, string>> {
	const { headers } = await loadCustomRoutes(config);
	const out = new Map<string, string>();
	for (const rule of headers) {
		const match = getPathMatch(rule.source, {
			strict: true,
			removeUnnamedParams: true,
		});
		if (!match(path)) continue;
		for (const { key, value } of rule.headers) {
			if (!out.has(key.toLowerCase())) out.set(key.toLowerCase(), value);
		}
	}
	return out;
}

const directive = (csp: string | undefined, name: string) =>
	csp
		?.split(";")
		.map((d) => d.trim())
		.find((d) => d.startsWith(`${name} `));

test("a page loads pictures and talks to nothing but this origin", async () => {
	for (const path of ["/", "/chat", "/settings", "/api/copilotkit"]) {
		const csp = (await headersFor(path)).get("content-security-policy");
		expect(directive(csp, "img-src")).toBe("img-src 'self' data: blob:");
		expect(directive(csp, "media-src")).toBe("media-src 'self' data: blob:");
		expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
		expect(csp).not.toContain("https:");
		// What the proxy does not replace admits no inline script and no eval.
		expect(directive(csp, "script-src")).toBe("script-src 'self'");
	}
});

test("the media relay is left to set its own policy, and keeps the rest", async () => {
	const media = await headersFor("/api/media/a/images/b.png");
	expect(media.has("content-security-policy")).toBe(false);
	expect(media.get("x-content-type-options")).toBe("nosniff");
	expect(media.get("strict-transport-security")).toBeDefined();
	expect(
		(await headersFor("/api/mediathing")).has("content-security-policy"),
	).toBe(true);
});
