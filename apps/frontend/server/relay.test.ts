import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The live socket's relay, on Node as the image runs it, between a browser's
 * socket and a stand-in backend on `Bun.serve`: the origin and the caller
 * checked before anything is opened, the assertion put on the backend's
 * upgrade and nothing of the browser's credentials, bytes both ways, either
 * end closing the other, and every refusal — this side's or the backend's —
 * readable on the socket as `{ type: "refused", status, body }` with the
 * close code 4000 + the status.
 */

const NODE = Bun.which("node");
const t = test.skipIf(!NODE);
const ORIGIN = "https://app.test";

type Upgrade = { headers: Record<string, string> };
const upgrades: Upgrade[] = [];
let backendClosed = 0;
let backend: ReturnType<typeof Bun.serve<Upgrade>>;
let relay: ReturnType<typeof Bun.spawn> | undefined;
let relayPort = 0;

beforeAll(async () => {
	if (!NODE) return;
	backend = Bun.serve<Upgrade>({
		port: 0,
		fetch(req, server) {
			if (new URL(req.url).pathname !== "/voice/live")
				return new Response(null, { status: 404 });
			const authorization = req.headers.get("authorization");
			if (authorization === "Bearer refused-by-standing")
				return Response.json({ code: "account_deactivated" }, { status: 403 });
			if (authorization === "Bearer never-answered")
				return new Promise<Response>(() => {});
			const data = { headers: Object.fromEntries(req.headers) };
			if (server.upgrade(req, { data })) return;
			return new Response(null, { status: 426 });
		},
		websocket: {
			open(ws) {
				upgrades.push(ws.data);
				ws.send(JSON.stringify({ type: "ready" }));
			},
			message(ws, message) {
				if (message === "hang up") ws.close(1000, "done");
				// Otherwise an echo: text back as text, audio back as audio.
				else ws.send(message);
			},
			close() {
				backendClosed++;
			},
		},
	});
	const out = mkdtempSync(join(tmpdir(), "relay-"));
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, "testing", "relay-harness.ts")],
		target: "node",
		outdir: out,
	});
	if (!built.success) throw new Error("the harness did not build");
	relay = Bun.spawn([NODE, join(out, "relay-harness.js")], {
		env: {
			...process.env,
			RELAY_TEST_BACKEND: `http://127.0.0.1:${backend.port}`,
			RELAY_TEST_ORIGIN: ORIGIN,
		},
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = (relay.stdout as ReadableStream<Uint8Array>).getReader();
	const { value } = await reader.read();
	relayPort = (JSON.parse(new TextDecoder().decode(value)) as { port: number })
		.port;
	reader.releaseLock();
});

afterAll(() => {
	relay?.kill();
	void backend?.stop(true);
});

interface Client {
	ws: WebSocket;
	messages: (string | ArrayBuffer)[];
	closed: Promise<{ code: number }>;
	next(): Promise<string | ArrayBuffer>;
}

function connect(headers: Record<string, string>): Client {
	const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/api/voice/live`, {
		headers,
	} as never);
	ws.binaryType = "arraybuffer";
	const messages: (string | ArrayBuffer)[] = [];
	const waiting: ((m: string | ArrayBuffer) => void)[] = [];
	ws.onmessage = (e) => {
		const next = waiting.shift();
		if (next) next(e.data);
		else messages.push(e.data);
	};
	const closed = new Promise<{ code: number }>((resolve) => {
		ws.onclose = (e) => resolve({ code: e.code });
	});
	return {
		ws,
		messages,
		closed,
		next: () =>
			messages.length
				? Promise.resolve(messages.shift() as string | ArrayBuffer)
				: new Promise((resolve) => waiting.push(resolve)),
	};
}

const signedIn = { origin: ORIGIN, cookie: "session=ok" };

interface Frame {
	opcode: number;
	payload: Buffer;
}

/**
 * The upgrade made by hand and the server's frames read off the wire: what
 * the relay sent, byte for byte. A WebSocket client reports a close through
 * its own reading of the code, and not every client hands every code on as
 * it came — a server's 1001 can be reported as 1000 — so a test of which
 * close the relay sends reads the frame itself.
 */
async function rawSocket(
	headers: Record<string, string>,
): Promise<{ frame(): Promise<Frame>; end(): void }> {
	let held = Buffer.alloc(0);
	let upgraded = false;
	const frames: Frame[] = [];
	const waiting: ((f: Frame) => void)[] = [];
	const read = () => {
		if (!upgraded) {
			const head = held.indexOf("\r\n\r\n");
			if (head < 0) return;
			if (!held.subarray(0, head).toString().startsWith("HTTP/1.1 101"))
				throw new Error("the relay did not accept the upgrade");
			held = held.subarray(head + 4);
			upgraded = true;
		}
		// A server's frames are unmasked, and the ones read here are short.
		while (held.length >= 2) {
			const length = (held[1] as number) & 0x7f;
			if (length > 125 || held.length < 2 + length) return;
			const frame = {
				opcode: (held[0] as number) & 0x0f,
				payload: Buffer.from(held.subarray(2, 2 + length)),
			};
			held = held.subarray(2 + length);
			const next = waiting.shift();
			if (next) next(frame);
			else frames.push(frame);
		}
	};
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port: relayPort,
		socket: {
			data(_socket, chunk) {
				held = Buffer.concat([held, chunk]);
				read();
			},
		},
	});
	socket.write(
		[
			"GET /api/voice/live HTTP/1.1",
			`Host: 127.0.0.1:${relayPort}`,
			"Upgrade: websocket",
			"Connection: Upgrade",
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
			"Sec-WebSocket-Version: 13",
			...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			"",
			"",
		].join("\r\n"),
	);
	return {
		frame: () =>
			frames.length
				? Promise.resolve(frames.shift() as Frame)
				: new Promise((resolve) => waiting.push(resolve)),
		end: () => socket.end(),
	};
}

t(
	"a signed-in page's socket reaches the backend under the assertion, with none of the browser's credentials, and carries text and audio both ways",
	async () => {
		const client = connect({
			...signedIn,
			authorization: "Bearer forged",
			"x-forwarded-for": "203.0.113.9",
			"x-account": "somebody-else",
		});
		expect(JSON.parse(String(await client.next()))).toEqual({ type: "ready" });
		const seen = upgrades.at(-1)?.headers ?? {};
		expect(seen.authorization).toBe("Bearer minted");
		expect(seen["accept-language"]).toBe("it");
		expect(seen.cookie).toBeUndefined();
		// Nothing the browser wrote crosses but the handshake itself.
		expect(seen.origin).toBeUndefined();
		expect(seen["x-forwarded-for"]).toBeUndefined();
		expect(seen["x-account"]).toBeUndefined();
		client.ws.send(JSON.stringify({ type: "start", threadId: "t" }));
		expect(JSON.parse(String(await client.next()))).toEqual({
			type: "start",
			threadId: "t",
		});
		const audio = new Uint8Array(4_800).fill(7);
		client.ws.send(audio);
		const back = await client.next();
		expect(back).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(back as ArrayBuffer)).toEqual(audio);
		const before = backendClosed;
		client.ws.close(1000);
		await client.closed;
		for (let i = 0; i < 100 && backendClosed === before; i++)
			await Bun.sleep(10);
		expect(backendClosed).toBe(before + 1);
	},
);

t("the backend closing the session closes the browser's socket", async () => {
	const client = connect(signedIn);
	await client.next();
	client.ws.send("hang up");
	expect((await client.closed).code).toBe(1000);
});

t(
	"a refusal is a message the pane can read and a close it can name: another origin, nobody signed in, the backend's own refusal",
	async () => {
		const cases: [Record<string, string>, number, unknown][] = [
			[
				{ origin: "https://evil.test", cookie: "session=ok" },
				403,
				{ code: "forbidden" },
			],
			[{ origin: ORIGIN }, 401, { code: "unauthenticated" }],
		];
		for (const [headers, status, body] of cases) {
			const client = connect(headers);
			expect(JSON.parse(String(await client.next()))).toEqual({
				type: "refused",
				status,
				body,
			});
			expect((await client.closed).code).toBe(4000 + status);
		}
		const before = upgrades.length;
		const deactivated = connect({
			origin: ORIGIN,
			cookie: "session=deactivated",
		});
		expect(JSON.parse(String(await deactivated.next()))).toEqual({
			type: "refused",
			status: 403,
			body: { code: "account_deactivated" },
		});
		expect((await deactivated.closed).code).toBe(4403);
		expect(upgrades.length).toBe(before);
	},
);

t(
	"a socket with no Origin is refused: only a page of this app opens one",
	async () => {
		const client = connect({ cookie: "session=ok" });
		expect(JSON.parse(String(await client.next()))).toEqual({
			type: "refused",
			status: 403,
			body: { code: "forbidden" },
		});
		expect((await client.closed).code).toBe(4403);
	},
);

t(
	"a backend that never answers the upgrade is said to be unreachable, in time",
	async () => {
		const client = connect({ origin: ORIGIN, cookie: "session=silent" });
		expect(JSON.parse(String(await client.next()))).toEqual({
			type: "refused",
			status: 503,
			body: { code: "backend_unreachable" },
		});
		expect((await client.closed).code).toBe(4503);
	},
);

t(
	"a stopping server closes the session with a close the browser can read, and the backend's end with it",
	async () => {
		const wire = await rawSocket(signedIn);
		await wire.frame();
		const before = backendClosed;
		// By its number as this system has it: a subprocess killed by the
		// signal's name is sent Linux's number for it, which on macOS is
		// another signal, one the harness does not handle.
		if (relay) process.kill(relay.pid, "SIGUSR2");
		const close = await wire.frame();
		expect(close.opcode).toBe(0x8);
		expect(close.payload.readUInt16BE(0)).toBe(1001);
		for (let i = 0; i < 100 && backendClosed === before; i++)
			await Bun.sleep(10);
		expect(backendClosed).toBe(before + 1);
		wire.end();
	},
);
