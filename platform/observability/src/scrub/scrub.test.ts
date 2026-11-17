import { afterEach, describe, expect, test } from "bun:test";
import {
	isProbePath,
	pathOf,
	redactPath,
	redactSegment,
	registerProbePaths,
	resetProbePaths,
	SAFE_QUERY_KEYS,
	scrubUrl,
	spanNameFor,
} from "./index";

/**
 * The assertions that decide whether export may be switched on at all. If one
 * goes red, the fix is the scrub, never the assertion.
 */

/** A signed blob URL's shape, with every SAS parameter it carries. */
const SIGNED_BLOB =
	"https://stexample.blob.core.windows.net/assets/photos/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44/portrait.jpg" +
	"?sv=2024-11-04&se=2026-09-05T12%3A00%3A00Z&sr=b&sp=r" +
	"&sig=Kx9%2BQ0dR7mZ1u3s8Yy4W5vT6nB2cA1pL0oI9uY8tG7e%3D";

const SUBJECT =
	"a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789::9f8e7d6c-5b4a-4321-9876-543210fedcba";

afterEach(resetProbePaths);

describe("a credential in a query string does not survive", () => {
	const requested = `/api/media?url=${encodeURIComponent(SIGNED_BLOB)}`;

	test("the signature is gone and only the route is left", () => {
		const scrubbed = scrubUrl(requested);
		expect(scrubbed).toBe("/api/media");
		expect(scrubbed).not.toContain("sig=");
		expect(scrubbed).not.toContain("blob.core.windows.net");
	});

	test("the absolute form, which is what http.url records", () => {
		expect(
			scrubUrl(
				`https://app.example.test/api/media?url=${encodeURIComponent(SIGNED_BLOB)}`,
			),
		).toBe("https://app.example.test/api/media");
	});

	test("a signed blob URL recorded as a client span loses its token too", () => {
		expect(scrubUrl(SIGNED_BLOB)).toBe(
			"https://stexample.blob.core.windows.net/assets/photos/:id/:id",
		);
	});
});

describe("an identifier never reaches the store", () => {
	test("as a query parameter", () => {
		const scrubbed = scrubUrl(
			`/api/memory/resource?resourceId=${encodeURIComponent(SUBJECT)}`,
		);
		expect(scrubbed).toBe("/api/memory/resource");
		expect(scrubbed).not.toContain("a1b2c3d4");
	});

	test("as a path segment", () => {
		expect(redactPath(`/memory/${SUBJECT}/notes`)).toBe("/memory/:id/notes");
	});

	test.each([
		["free text, which is to say names", "/api/search?q=Some%20Person"],
		[
			"a conversation id",
			"/api/threads?id=8f14e45f-ceea-467a-9c1c-2f6b1c4a3d21",
		],
		["an address", "/api/access?email=someone%40example.test"],
	])("%s in the query", (_name, url) => {
		expect(scrubUrl(url)).toBe(url.slice(0, url.indexOf("?")));
	});
});

describe("the allowlist, which is the only way a parameter survives", () => {
	test("a boring key with a boring value is kept", () => {
		expect(scrubUrl("/api/list?locale=en&limit=50")).toBe(
			"/api/list?locale=en&limit=50",
		);
	});

	test("an allowlisted key with a payload-shaped value is not", () => {
		expect(scrubUrl(`/api/list?type=${"a".repeat(64)}`)).toBe("/api/list");
	});

	test("nothing identifying is on the list", () => {
		for (const key of [
			"url",
			"resourceId",
			"id",
			"thread",
			"q",
			"email",
			"token",
			"key",
			"sig",
			"se",
			"sp",
			"sv",
			"user",
		]) {
			expect(SAFE_QUERY_KEYS.has(key)).toBe(false);
		}
	});

	test("a URL with nothing left does not end in a bare question mark", () => {
		expect(scrubUrl("/api/media?url=x")).toBe("/api/media");
	});
});

describe("path segments: a route word survives, a value does not", () => {
	test.each(["prompts", "api-key", "sha256", "v1", ":id", "[...path]"])(
		"keeps %p",
		(segment) => {
			expect(redactSegment(segment)).toBe(segment);
		},
	);

	test.each([
		// A UUID in both the digit-leading and the letter-leading shape; the
		// second reads as a route word if only the character class is checked.
		"6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44",
		"abcd1234-e29b-41d4-a716-446655440000",
		"12",
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"portrait.jpg",
		"some-person.png",
		"someone@example.test",
		"eyJhbGciOiJIUzI1NiJ9",
	])("redacts %p", (segment) => {
		expect(redactSegment(segment)).toBe(":id");
	});

	test("path parameters collapse to one series", () => {
		expect(redactPath("/prompts/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44")).toBe(
			"/prompts/:id",
		);
		expect(redactPath("/assets/progress/8412")).toBe("/assets/progress/:id");
		expect(
			redactPath(
				"/assets/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44/original/portrait.jpg",
			),
		).toBe("/assets/:id/original/:id");
	});

	test("a trailing slash is a different route and stays one", () => {
		expect(redactPath("/content/")).toBe("/content/");
		expect(redactPath("/content")).toBe("/content");
	});
});

describe("probe paths, which are noise at any sampling rate", () => {
	test.each(["/health", "/healthz", "/favicon.ico", "/health/"])(
		"%p is a probe",
		(path) => {
			expect(isProbePath(path)).toBe(true);
		},
	);

	test("a build's static chunks are noise too", () => {
		expect(isProbePath("/_next/static/chunks/main-8f14e45fceea467a.js")).toBe(
			true,
		);
		expect(isProbePath("/_next/image")).toBe(false);
	});

	test("a real route that merely starts the same way is not a probe", () => {
		expect(isProbePath("/healthcheck-settings")).toBe(false);
		expect(isProbePath("/")).toBe(false);
	});

	test("a service registers its own, and a registration survives a repeat", () => {
		expect(isProbePath("/api/warm")).toBe(false);
		registerProbePaths(["/api/warm", "/api/vitals"]);
		registerProbePaths(["/api/warm"]);
		expect(isProbePath("/api/warm")).toBe(true);
		expect(isProbePath("/api/vitals")).toBe(true);
		resetProbePaths();
		expect(isProbePath("/api/warm")).toBe(false);
	});
});

describe("pathOf, which recognises a probe without parsing a URL", () => {
	test.each([
		["https://app.example.test/api/media?url=x", "/api/media"],
		["http://localhost:4111/health", "/health"],
		["/api/vitals?beacon=1", "/api/vitals"],
		["/health#frag", "/health"],
		["https://app.example.test", "/"],
		["nonsense", "/"],
	])("%p → %p", (raw, expected) => {
		expect(pathOf(raw)).toBe(expected);
	});
});

describe("what a URL that will not parse gets", () => {
	test("nothing — an unparseable URL is the shape a hand-built one has", () => {
		expect(scrubUrl("not a url at all")).toBe("");
	});

	test("userinfo goes with the authority", () => {
		expect(
			scrubUrl("https://admin:hunter2@app.example.test/prompts"),
		).not.toContain("hunter2");
	});
});

describe("span names, which are a cardinality control", () => {
	test("method and route, upper-cased; a nameless route degrades to the verb", () => {
		expect(spanNameFor("get", "/prompts/:id")).toBe("GET /prompts/:id");
		expect(spanNameFor("post", "")).toBe("POST");
	});
});
