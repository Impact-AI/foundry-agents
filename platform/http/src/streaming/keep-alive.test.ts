import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { HEARTBEAT_FRAME } from "./heartbeat";
import {
	DEFAULT_SSE_HEARTBEAT_MS,
	heartbeatIntervalMs,
	keepStreamAlive,
	PROXY_BUFFERING_HEADER,
	withoutProxyBuffering,
} from "./keep-alive";

/** An SSE body that says one thing, after `silenceMs` of nothing. */
function slowEventStream(silenceMs: number): ReadableStream<string> {
	return new ReadableStream<string>({
		async start(controller) {
			await Bun.sleep(silenceMs);
			controller.enqueue(`data: ${JSON.stringify({ type: "done" })}\n\n`);
			controller.close();
		},
	});
}

const saved = process.env.SSE_HEARTBEAT_MS;
afterEach(() => {
	if (saved === undefined) delete process.env.SSE_HEARTBEAT_MS;
	else process.env.SSE_HEARTBEAT_MS = saved;
});

describe("heartbeatIntervalMs", () => {
	test("defaults, reads the knob, and takes 0 as the heartbeat off", () => {
		delete process.env.SSE_HEARTBEAT_MS;
		expect(heartbeatIntervalMs()).toBe(DEFAULT_SSE_HEARTBEAT_MS);
		process.env.SSE_HEARTBEAT_MS = "2500";
		expect(heartbeatIntervalMs()).toBe(2500);
		process.env.SSE_HEARTBEAT_MS = "0";
		expect(heartbeatIntervalMs()).toBe(0);
	});

	test("a malformed value is the default, never a heartbeat that silently is not running", () => {
		process.env.SSE_HEARTBEAT_MS = "30s";
		expect(heartbeatIntervalMs()).toBe(DEFAULT_SSE_HEARTBEAT_MS);
	});
});

describe("withoutProxyBuffering", () => {
	test("states the header and keeps status, body and other headers", async () => {
		const res = withoutProxyBuffering(
			new Response("hi", {
				status: 206,
				headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
			}),
		);
		expect(res.headers.get(PROXY_BUFFERING_HEADER)).toBe("no");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.status).toBe(206);
		expect(await res.text()).toBe("hi");
	});
});

describe("keepStreamAlive, served over HTTP", () => {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/events")
				return keepStreamAlive(
					new Response(slowEventStream(120), {
						headers: { "Content-Type": "text/event-stream" },
					}),
					20,
				);
			if (url.pathname === "/json")
				return keepStreamAlive(
					new Response(slowEventStream(60), {
						headers: { "Content-Type": "application/json" },
					}),
					10,
				);
			return keepStreamAlive(new Response(null, { status: 204 }), 10);
		},
	});
	afterAll(() => server.stop(true));

	const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

	test("an SSE response arrives with the header, beats during the silence, and the event intact", async () => {
		const res = await fetch(url("/events"));
		expect(res.headers.get(PROXY_BUFFERING_HEADER)).toBe("no");
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no body");
		const decoder = new TextDecoder();
		let text = "";
		let beatsBeforeEvent = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			if (!text.includes("data:"))
				beatsBeforeEvent = text.split(HEARTBEAT_FRAME).length - 1;
		}
		// Beats reached the client while the origin was still silent.
		expect(beatsBeforeEvent).toBeGreaterThanOrEqual(2);
		expect(text).toContain('data: {"type":"done"}\n\n');
	});

	test("a non-SSE body gets the header and no injected bytes", async () => {
		const res = await fetch(url("/json"));
		expect(res.headers.get(PROXY_BUFFERING_HEADER)).toBe("no");
		expect(await res.text()).toBe('data: {"type":"done"}\n\n');
	});

	test("a bodiless response passes through", async () => {
		const res = await fetch(url("/none"));
		expect(res.status).toBe(204);
		expect(res.headers.get(PROXY_BUFFERING_HEADER)).toBe("no");
	});
});

test("a fetched response is relayed without the encoding its body no longer has", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response(Bun.gzipSync(new TextEncoder().encode("data: hello\n\n")), {
				headers: {
					"content-type": "text/event-stream",
					"content-encoding": "gzip",
				},
			}),
	});
	try {
		const relayed = keepStreamAlive(await fetch(server.url), 0);
		expect(relayed.headers.get("content-encoding")).toBeNull();
		expect(relayed.headers.get("content-length")).toBeNull();
		expect(await relayed.text()).toBe("data: hello\n\n");
	} finally {
		await server.stop(true);
	}
});

test("a locally built response keeps its own encoding, and its encoded bytes take no frame", async () => {
	const bytes = Bun.gzipSync(new TextEncoder().encode("data: hello\n\n"));
	const kept = keepStreamAlive(
		new Response(bytes, {
			headers: {
				"content-type": "text/event-stream",
				"content-encoding": "gzip",
			},
		}),
		5,
	);
	expect(kept.headers.get("content-encoding")).toBe("gzip");
	expect(new Uint8Array(await kept.arrayBuffer())).toEqual(bytes);
});
