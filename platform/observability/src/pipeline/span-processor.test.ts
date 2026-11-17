import { describe, expect, test } from "bun:test";
import type {
	ReadableSpan,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ScrubbingLogRecordProcessor } from "./log-processor";
import { ScrubbingSpanProcessor } from "./span-processor";

/**
 * The scrub as the pipeline sees it: applied to the object the exporter will
 * serialise, the span renamed to something of bounded cardinality, a probe
 * never reaching the delegate. Both attribute spellings are covered because
 * both are in the wild.
 */

function span(
	attributes: Record<string, unknown>,
	name = "HTTP GET",
): ReadableSpan {
	return { name, attributes } as unknown as ReadableSpan;
}

function recorder(): { seen: ReadableSpan[]; processor: SpanProcessor } {
	const seen: ReadableSpan[] = [];
	return {
		seen,
		processor: {
			onStart: () => {},
			onEnd: (s) => {
				seen.push(s);
			},
			forceFlush: () => Promise.resolve(),
			shutdown: () => Promise.resolve(),
		},
	};
}

const SIGNED_BLOB =
	"https://stexample.blob.core.windows.net/assets/photos/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44/portrait.jpg?sig=Kx9%2BQ0dR7mZ1u3s8";

describe("what reaches the exporter", () => {
	test("a credential in the URL and the caller's address do not", () => {
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(
			span({
				"http.request.method": "GET",
				"url.full": `https://app.example.test/api/media?url=${encodeURIComponent(SIGNED_BLOB)}`,
				"url.path": "/api/media",
				"url.query": `url=${encodeURIComponent(SIGNED_BLOB)}`,
				"client.address": "203.0.113.7",
			}),
		);
		expect(seen).toHaveLength(1);
		const exported = JSON.stringify(seen[0]);
		expect(exported).not.toContain("sig=");
		expect(exported).not.toContain("photos");
		expect(exported).not.toContain("203.0.113.7");
	});

	test("an identifier does not, in the older attribute spelling", () => {
		const subject =
			"a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789::9f8e7d6c-5b4a-4321-9876-543210fedcba";
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(
			span({
				"http.method": "DELETE",
				"http.url": `http://backend/api/memory/resource?resourceId=${encodeURIComponent(subject)}`,
				"http.target": `/api/memory/resource?resourceId=${encodeURIComponent(subject)}`,
				"http.client_ip": "203.0.113.7",
			}),
		);
		expect(JSON.stringify(seen[0])).not.toContain("a1b2c3d4");
		expect(seen[0]?.attributes["http.target"]).toBe("/api/memory/resource");
	});

	test("every attribute on the drop list is gone, and the app's own hostname stays", () => {
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(
			span({
				"url.path": "/api/list",
				"server.address": "backend",
				"client.address": "203.0.113.7",
				"client.port": 54321,
				"net.peer.ip": "203.0.113.7",
				"network.peer.address": "10.0.4.19",
				"network.peer.port": 44210,
				"user_agent.original": "Mozilla/5.0 (a fingerprint)",
				"http.request.header.cookie": "session=…",
				"enduser.id": "someone@example.test",
			}),
		);
		const attributes = seen[0]?.attributes ?? {};
		for (const dropped of [
			"client.address",
			"client.port",
			"net.peer.ip",
			"network.peer.address",
			"network.peer.port",
			"user_agent.original",
			"http.request.header.cookie",
			"enduser.id",
		]) {
			expect(dropped in attributes).toBe(false);
		}
		expect(attributes["server.address"]).toBe("backend");
	});
});

describe("cardinality", () => {
	test("the span is renamed after its route, not after the path requested", () => {
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(
			span({
				"http.request.method": "GET",
				"url.path": "/prompts/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44",
			}),
		);
		expect(seen[0]?.name).toBe("GET /prompts/:id");
	});

	test("a route the server declared is redacted too, and wins", () => {
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(
			span({
				"http.request.method": "POST",
				"http.route": "/assets/progress/:id",
				"url.path": "/assets/progress/8412",
			}),
		);
		expect(seen[0]?.name).toBe("POST /assets/progress/:id");
	});

	test("scrubbing twice changes nothing the second time", () => {
		const { processor } = recorder();
		const scrubber = new ScrubbingSpanProcessor({ delegate: processor });
		const s = span({
			"http.request.method": "GET",
			"url.path": "/prompts/6f1c2b7e-9f0a-4d2e-b3c1-8a5e2f0d7c44",
		});
		scrubber.onEnd(s);
		const once = JSON.stringify(s);
		scrubber.onEnd(s);
		expect(JSON.stringify(s)).toBe(once);
	});
});

describe("probes", () => {
	test.each([
		["/health", "url.path"],
		["/healthz", "http.target"],
		["/favicon.ico", "url.path"],
	])("%p never reaches the delegate", (path, attribute) => {
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(
			span({ "http.request.method": "GET", [attribute]: path }),
		);
		expect(seen).toHaveLength(0);
	});

	test("a real request does", () => {
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(
			span({ "http.request.method": "GET", "url.path": "/api/list" }),
		);
		expect(seen).toHaveLength(1);
	});

	test("without a delegate there is nothing to drop, and nothing throws", () => {
		// The distro case: beside the exporter, the processor edits but cannot
		// withhold. Probes are refused by the sampler there instead.
		expect(() =>
			new ScrubbingSpanProcessor().onEnd(
				span({ "http.request.method": "GET", "url.path": "/health" }),
			),
		).not.toThrow();
	});
});

describe("failing closed", () => {
	test("a span that cannot be scrubbed is dropped, not exported raw", () => {
		const { seen, processor } = recorder();
		const hostile = {
			name: "GET",
			attributes: new Proxy(
				{ "url.path": "/api/media" },
				{
					get() {
						throw new Error("no");
					},
				},
			),
		} as unknown as ReadableSpan;
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd(hostile);
		expect(seen).toHaveLength(0);
	});

	test("with no delegate to withhold it from, a span that cannot be scrubbed is emptied", () => {
		// The distro case: the exporter's own processor serialises the same
		// object whatever this one does.
		const attributes: Record<string, unknown> = {
			"url.full": "https://app.example.test/a?token=secret",
		};
		const eventAttributes = { "client.address": "203.0.113.7" };
		const hostile = {
			name: "GET /a?token=secret",
			attributes,
			get events() {
				return [
					{
						name: "x",
						get attributes() {
							if (Object.keys(eventAttributes).length === 0) return {};
							return new Proxy(eventAttributes, {
								get(target, key, receiver) {
									if (key === "http.route") throw new Error("no");
									return Reflect.get(target, key, receiver);
								},
							});
						},
					},
				];
			},
		} as unknown as ReadableSpan;
		new ScrubbingSpanProcessor().onEnd(hostile);
		expect(Object.keys(attributes)).toEqual([]);
		expect(Object.keys(eventAttributes)).toEqual([]);
		expect(hostile.name).toBe("unscrubbed");
	});

	test("forceFlush and shutdown reach the delegate", async () => {
		let flushed = false;
		let stopped = false;
		const scrubber = new ScrubbingSpanProcessor({
			delegate: {
				onStart: () => {},
				onEnd: () => {},
				forceFlush: async () => {
					flushed = true;
				},
				shutdown: async () => {
					stopped = true;
				},
			},
		});
		await scrubber.forceFlush();
		await scrubber.shutdown();
		expect(flushed && stopped).toBe(true);
	});
});

describe("span events and log records get the same treatment", () => {
	test("a credential on an event does not reach the delegate; the code survives", () => {
		const { seen, processor } = recorder();
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd({
			name: "POST /api/chat",
			attributes: { "http.request.method": "POST" },
			events: [
				{
					name: "problem",
					attributes: {
						"problem.code": "chat.refused.image_too_large",
						"url.full": `https://app.example.test/api/media?url=${encodeURIComponent(SIGNED_BLOB)}`,
						"client.address": "203.0.113.7",
					},
				},
				{ name: "exception" },
			],
		} as unknown as ReadableSpan);
		expect(seen).toHaveLength(1);
		const exported = JSON.stringify(seen[0]);
		expect(exported).not.toContain("sig=");
		expect(exported).not.toContain("203.0.113.7");
		expect(exported).toContain("chat.refused.image_too_large");
	});

	test("an error's message and stack, the status and a name built from a URL are scrubbed", () => {
		const { seen, processor } = recorder();
		const leaky = `fetch to ${SIGNED_BLOB} failed for ada@example.test`;
		new ScrubbingSpanProcessor({ delegate: processor }).onEnd({
			name: `fetch GET ${SIGNED_BLOB}`,
			attributes: { "next.span_name": `fetch GET ${SIGNED_BLOB}` },
			status: { code: 2, message: leaky },
			events: [
				{
					name: "exception",
					attributes: {
						"exception.type": "Error",
						"exception.message": leaky,
						"exception.stacktrace": `Error: ${leaky}\n    at f (/app/a.ts:1:1)`,
					},
				},
			],
		} as unknown as ReadableSpan);
		expect(seen).toHaveLength(1);
		const exported = JSON.stringify(seen[0]);
		expect(exported).not.toContain("sig=");
		expect(exported).not.toContain("ada@example.test");
		expect(exported).not.toContain("6f1c2b7e");
		expect(exported).toContain("at f (/app/a.ts:1:1)");
		expect(seen[0]?.name).toBe(
			"fetch GET https://stexample.blob.core.windows.net/assets/photos/:id/:id",
		);
	});

	test("a URL attribute on a log record is scrubbed and the address dropped", () => {
		const attributes: Record<string, unknown> = {
			"http.url": `https://app.example.test/api/media?url=${encodeURIComponent(SIGNED_BLOB)}`,
			"client.address": "203.0.113.7",
		};
		new ScrubbingLogRecordProcessor().onEmit({
			attributes,
		} as unknown as Parameters<ScrubbingLogRecordProcessor["onEmit"]>[0]);
		expect(JSON.stringify(attributes)).not.toContain("sig=");
		expect("client.address" in attributes).toBe(false);
	});
});
