import type { ServerMessage } from "../messages";

/**
 * A browser's side of a live session, as the pane drives it, for tests: a
 * WebSocket to the backend's `/voice/live`, every text message read and
 * kept in order, every audio frame counted, and the close kept.
 */
export interface BrowserSocketClient {
	readonly messages: ServerMessage[];
	/** Bytes of the voice's audio received. */
	readonly audioBytes: () => number;
	readonly closed: Promise<{ code: number; reason: string }>;
	send(message: unknown): void;
	/** A frame of the person's audio: PCM16 at the session's rate. */
	sendAudio(bytes: Uint8Array): void;
	/** The first message from now or before that `match` answers for. */
	next<T extends ServerMessage>(
		match: (message: ServerMessage) => message is T,
		timeoutMs?: number,
	): Promise<T>;
	next(
		match: (message: ServerMessage) => boolean,
		timeoutMs?: number,
	): Promise<ServerMessage>;
	close(): void;
}

export async function openBrowserSocket(
	url: string,
	init: { headers?: Record<string, string> } = {},
): Promise<BrowserSocketClient> {
	const ws = new WebSocket(url, { headers: init.headers ?? {} } as never);
	ws.binaryType = "arraybuffer";
	const messages: ServerMessage[] = [];
	const watchers = new Set<() => void>();
	let audio = 0;
	const closed = Promise.withResolvers<{ code: number; reason: string }>();
	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string")
			messages.push(JSON.parse(event.data) as ServerMessage);
		else audio += (event.data as ArrayBuffer).byteLength;
		for (const watcher of [...watchers]) watcher();
	});
	ws.addEventListener("close", (event) => {
		closed.resolve({ code: event.code, reason: event.reason });
		for (const watcher of [...watchers]) watcher();
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("no upgrade")), {
			once: true,
		});
	});
	return {
		messages,
		audioBytes: () => audio,
		closed: closed.promise,
		send: (message) => ws.send(JSON.stringify(message)),
		sendAudio: (bytes) => ws.send(bytes),
		next: (match: (message: ServerMessage) => boolean, timeoutMs = 5_000) =>
			new Promise<ServerMessage>((resolve, reject) => {
				let seen = 0;
				const look = () => {
					for (; seen < messages.length; seen++) {
						const message = messages[seen] as ServerMessage;
						if (match(message)) {
							done();
							resolve(message);
							return;
						}
					}
					if (ws.readyState === WebSocket.CLOSED) {
						done();
						reject(new Error("the socket closed first"));
					}
				};
				const timer = setTimeout(() => {
					done();
					reject(new Error("no such message in time"));
				}, timeoutMs);
				const done = () => {
					clearTimeout(timer);
					watchers.delete(look);
				};
				watchers.add(look);
				look();
			}),
		close: () => ws.close(1000),
	} as BrowserSocketClient;
}
