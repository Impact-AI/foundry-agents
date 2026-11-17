/**
 * A server that speaks just enough RESP for the client to connect, then
 * behaves as told: answers every command `+OK`, an integer, an error, nil, or
 * nothing at all, and one verb differently from the rest when told to. For the states a real Redis cannot be asked to produce on
 * demand: a socket that is up and silent, and a reply that cannot be the
 * command's.
 */
export type FakeBehaviour = "ok" | "integer" | "error" | "nil" | "mute";

export interface FakeRedisServer {
	readonly port: number;
	readonly url: string;
	behave(behaviour: FakeBehaviour): void;
	/** Answer one verb its own way, whatever the rest are answered. */
	behaveFor(verb: string, behaviour: FakeBehaviour): void;
	/** Every command verb received since start, in order; the handshake is not one. */
	verbs(): string[];
	/** How many connections completed the handshake. */
	dials(): number;
	/** The credential each handshake carried, in dial order; empty for a handshake without one. */
	handshakes(): { username: string; password: string }[];
	stop(): void;
}

interface Command {
	verb: string;
	args: string[];
}

/** The RESP arrays in one packet: `*N`, then N bulk strings, each a length line and a value line. */
function commands(packet: string): Command[] {
	const lines = packet.split("\r\n");
	const out: Command[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.startsWith("*")) continue;
		const count = Number(line.slice(1));
		const parts: string[] = [];
		for (let n = 0; n < count; n++) parts.push(lines[i + 2 + 2 * n] ?? "");
		out.push({ verb: parts[0] ?? "", args: parts.slice(1) });
	}
	return out;
}

const REPLY: Record<Exclude<FakeBehaviour, "mute">, string> = {
	ok: "+OK\r\n",
	integer: ":42\r\n",
	error: "-ERR refused\r\n",
	nil: "_\r\n",
};

export function startFakeRedisServer(port = 0): FakeRedisServer {
	let behaviour: FakeBehaviour = "ok";
	const byVerb = new Map<string, FakeBehaviour>();
	const received: Command[] = [];
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port,
		socket: {
			data(socket, data) {
				for (const command of commands(data.toString())) {
					received.push(command);
					// The handshake is always answered, so a connection succeeds
					// whatever the server then does with commands.
					if (command.verb === "HELLO") socket.write(REPLY.ok);
					else {
						const how = byVerb.get(command.verb) ?? behaviour;
						if (how !== "mute") socket.write(REPLY[how]);
					}
				}
			},
			open() {},
			close() {},
			error() {},
		},
	});
	return {
		port: server.port,
		url: `redis://127.0.0.1:${server.port}`,
		behave(next) {
			behaviour = next;
		},
		behaveFor(verb, how) {
			byVerb.set(verb, how);
		},
		verbs: () => received.map((c) => c.verb).filter((verb) => verb !== "HELLO"),
		dials: () => received.filter((c) => c.verb === "HELLO").length,
		// `HELLO 3 AUTH <username> <password>`; without AUTH the pair is empty.
		handshakes: () =>
			received
				.filter((c) => c.verb === "HELLO")
				.map((c) => {
					const at = c.args.indexOf("AUTH");
					return at < 0
						? { username: "", password: "" }
						: {
								username: c.args[at + 1] ?? "",
								password: c.args[at + 2] ?? "",
							};
				}),
		stop: () => server.stop(true),
	};
}
