/**
 * Test-only: the browser's audio surface and the session's socket, faked
 * just far enough to see what the live link opens, what it sends, and
 * whether it lets it go. Every object records what was done to it — a track
 * stopped, a context closed, a worklet disconnected, a socket closed — the
 * microphone can be held at the permission prompt, which is where the
 * races live, and the test plays the server's side of the socket.
 * `install()` replaces the globals and returns the handle that restores
 * them.
 */

class FakeTrack {
	enabled = true;
	stopped = false;
	onended: (() => void) | null = null;
	stop() {
		this.stopped = true;
	}
	/** The device went: unplugged, or taken by the system. */
	end() {
		this.onended?.();
	}
}

class FakeStream {
	readonly tracks = [new FakeTrack()];
	getTracks() {
		return this.tracks;
	}
	getAudioTracks() {
		return this.tracks;
	}
	get live() {
		return this.tracks.some((t) => !t.stopped);
	}
}

class FakePort {
	readonly posted: unknown[] = [];
	onmessage: ((e: { data: unknown }) => void) | null = null;
	postMessage(message: unknown) {
		this.posted.push(message);
	}
	/** The worklet posts to the page. */
	emit(data: unknown) {
		this.onmessage?.({ data });
	}
}

class FakeWorklet {
	readonly port = new FakePort();
	connected = false;
	disconnected = false;
	constructor(
		readonly name: string,
		readonly options: Record<string, unknown>,
	) {}
	connect() {
		this.connected = true;
	}
	disconnect() {
		this.disconnected = true;
	}
}

class FakeAudioContext {
	closed = false;
	resumed = false;
	readonly modules: string[] = [];
	readonly destination = {};
	readonly audioWorklet = {
		addModule: async (url: string) => {
			this.modules.push(url);
		},
	};
	createAnalyser() {
		return { fftSize: 0, connect() {} };
	}
	createMediaStreamSource() {
		return { connect() {} };
	}
	async resume() {
		this.resumed = true;
	}
	async close() {
		this.closed = true;
	}
}

/** The session's socket: the test plays the server. */
class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = 0;
	binaryType = "blob";
	bufferedAmount = 0;
	readonly sent: unknown[] = [];
	closedWith: number | null = null;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
	onclose: ((e: { code: number }) => void) | null = null;
	constructor(readonly url: string) {}
	send(data: string | ArrayBuffer) {
		this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
	}
	close(code = 1000) {
		if (this.readyState === 3) return;
		this.closedWith = code;
		this.readyState = 3;
		this.onclose?.({ code });
	}
	/** The upgrade went through. */
	accept() {
		this.readyState = 1;
		this.onopen?.();
	}
	/** The server says something. */
	say(message: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	/** The server sends the voice's audio. */
	audio(bytes: number) {
		this.onmessage?.({ data: new ArrayBuffer(bytes) });
	}
	/** The server, or the network, ends the socket. */
	drop(code = 1006) {
		this.readyState = 3;
		this.onclose?.({ code });
	}
	/** The messages the page sent as text. */
	get texts() {
		return this.sent.filter((m) => !(m instanceof ArrayBuffer)) as {
			type: string;
			[field: string]: unknown;
		}[];
	}
}

export interface FakeBrowser {
	streams: FakeStream[];
	contexts: FakeAudioContext[];
	worklets: FakeWorklet[];
	sockets: FakeSocket[];
	/** Hold every microphone request at the prompt until `allowMic()`. */
	holdMic: boolean;
	allowMic: () => void;
	restore: () => void;
}

/** Lets every queued promise and microtask run. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

export function install(): FakeBrowser {
	const g = globalThis as Record<string, unknown>;
	const saved = new Map<string, unknown>();
	const replace = (name: string, value: unknown) => {
		saved.set(name, g[name]);
		g[name] = value;
	};
	const prompts: (() => void)[] = [];

	const browser: FakeBrowser = {
		streams: [],
		contexts: [],
		worklets: [],
		sockets: [],
		holdMic: false,
		allowMic: () => {
			for (const allow of prompts.splice(0)) allow();
		},
		restore: () => {
			for (const [name, value] of saved) {
				if (value === undefined) delete g[name];
				else g[name] = value;
			}
			delete (navigator as unknown as Record<string, unknown>).mediaDevices;
		},
	};

	const getUserMedia = () =>
		new Promise<FakeStream>((resolve) => {
			const allow = () => {
				const stream = new FakeStream();
				browser.streams.push(stream);
				resolve(stream);
			};
			if (browser.holdMic) prompts.push(allow);
			else allow();
		});
	Object.defineProperty(navigator, "mediaDevices", {
		value: { getUserMedia },
		configurable: true,
	});
	replace("window", {
		isSecureContext: true,
		location: { protocol: "https:", host: "app.test" },
	});
	replace(
		"AudioContext",
		class extends FakeAudioContext {
			constructor() {
				super();
				browser.contexts.push(this);
			}
		},
	);
	replace(
		"AudioWorkletNode",
		class extends FakeWorklet {
			constructor(
				_context: unknown,
				name: string,
				options: Record<string, unknown>,
			) {
				super(name, options);
				browser.worklets.push(this);
			}
		},
	);
	replace(
		"WebSocket",
		class extends FakeSocket {
			constructor(url: string) {
				super(url);
				browser.sockets.push(this);
			}
		},
	);
	return browser;
}
