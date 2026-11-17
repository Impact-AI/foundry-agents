/**
 * smoke with `azd` stood in for on PATH and a frontend stood in for by a
 * server in this process, each twin in turn: it answers as the demo's does,
 * holds a session by the cookie the sign-in sets, and can be made to fail one
 * route. The account the run signs in as is deleted however the run ends,
 * and the sample library is expected or not by the same reading of
 * SEED_SAMPLE_LIBRARY the deploy has.
 */
import { expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eachTwin, type Shell, startTwin } from "../hooks/twins";

const SCRIPT = join(import.meta.dir, "smoke");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function smoke(
	shell: Shell,
	options: {
		library?: number;
		seed?: string;
		mode?: string;
		/** What deleting the account answers. */
		erase?: number;
		/** The sign-in makes the account and sets the cookie, and its answer breaks off. */
		signInBreaks?: boolean;
	} = {},
) {
	const calls: string[] = [];
	let account = false;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const { pathname, search } = new URL(request.url);
			calls.push(`${request.method} ${pathname}${search}`);
			const signedIn =
				account && (request.headers.get("cookie") ?? "").includes("session=1");
			switch (`${request.method} ${pathname}`) {
				case "GET /health":
				case "GET /login":
					return new Response("ok");
				case "GET /api/conversations":
					return signedIn
						? Response.json([])
						: Response.json({ code: "unauthenticated" }, { status: 401 });
				case "GET /api/auth/csrf":
					return Response.json({ csrfToken: "token" });
				case "POST /api/auth/callback/local": {
					const form = new URLSearchParams(await request.text());
					if (form.get("csrfToken") !== "token" || !form.get("name"))
						return new Response("no", { status: 400 });
					account = true;
					return new Response("ok", {
						headers: { "set-cookie": "session=1; Path=/" },
					});
				}
				case "GET /api/library":
					return Response.json(
						options.seed?.toLowerCase() === "false"
							? []
							: [{ title: "Onboarding handbook" }],
						{ status: options.library ?? 200 },
					);
				case "POST /api/copilotkit": {
					const turn = await request.json();
					const said = turn?.body?.messages?.[0];
					if (
						!signedIn ||
						turn?.method !== "agent/run" ||
						!UUID.test(turn?.body?.threadId) ||
						!UUID.test(turn?.body?.runId) ||
						!UUID.test(said?.id) ||
						said?.content !== "Hello"
					)
						return new Response("no", { status: 400 });
					return new Response(
						'data: {"type":"TEXT_MESSAGE_CONTENT"}\n\ndata: {"type":"RUN_FINISHED"}\n\n',
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				case "DELETE /api/account":
					if (!signedIn)
						return Response.json({ code: "unauthenticated" }, { status: 401 });
					if (options.erase)
						return new Response(null, { status: options.erase });
					account = false;
					return new Response(null, { status: 204 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	// In front of the server where the sign-in's answer is to break off: the
	// request goes through, and of the answer only the headers come back
	// before the connection is dropped.
	const front = options.signInBreaks
		? createServer((client) => {
				const upstream = connect(server.port ?? 0, "127.0.0.1");
				let cut = false;
				client.on("data", (chunk) => {
					if (chunk.toString().startsWith("POST /api/auth/callback/local"))
						cut = true;
					upstream.write(chunk);
				});
				upstream.on("data", (chunk) => {
					if (!cut) return void client.write(chunk);
					const text = chunk.toString("latin1");
					client.write(text.slice(0, text.indexOf("\r\n\r\n") + 4), "latin1");
					client.destroy();
					upstream.destroy();
				});
				for (const socket of [client, upstream]) socket.on("error", () => {});
				client.on("close", () => upstream.destroy());
				upstream.on("close", () => client.destroy());
			})
		: null;
	if (front)
		await new Promise<void>((listening) =>
			front.listen(0, "127.0.0.1", listening),
		);
	const port = front
		? (front.address() as AddressInfo).port
		: (server.port ?? 0);
	try {
		const bin = mkdtempSync(join(tmpdir(), "smoke-"));
		writeFileSync(
			join(bin, "azd"),
			`#!/bin/sh\nprintf '%s\\n' 'FRONTEND_URL="http://127.0.0.1:${port}/"' 'AUTH_MODE="${options.mode ?? "local"}"' 'SEED_SAMPLE_LIBRARY="${options.seed ?? "true"}"'\n`,
		);
		chmodSync(join(bin, "azd"), 0o755);
		const run = await startTwin(shell, SCRIPT, [], {
			PATH: `${bin}:${process.env.PATH}`,
		});
		return { ...run, calls, account };
	} finally {
		front?.close();
		await server.stop(true);
	}
}

const DELETE = "DELETE /api/account";

eachTwin(
	"a run that passes signs in, lists the library, sends a turn and deletes its account, once",
	async (shell) => {
		const run = await smoke(shell);
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		expect(run.stdout.trim().split("\n")).toEqual([
			expect.stringMatching(/^smoke: ok {3}http:\S+\/health answers$/),
			"smoke: ok   the door answers",
			"smoke: ok   an API call without a session is refused (401)",
			"smoke: ok   a local sign-in holds a session",
			"smoke: ok   the library lists the sample's documents",
			"smoke: ok   a chat turn streams an answer",
			"smoke: ok   the smoke test's account is deleted",
		]);
		expect(run.calls).toEqual([
			"GET /health",
			"GET /login",
			"GET /api/conversations",
			"GET /api/auth/csrf",
			"POST /api/auth/callback/local",
			"GET /api/conversations",
			"GET /api/library?query=onboarding",
			"POST /api/copilotkit",
			DELETE,
		]);
		expect(run.account).toBe(false);
	},
);

eachTwin(
	"a check that fails after the sign-in still deletes the account the run made",
	async (shell) => {
		const run = await smoke(shell, { library: 500 });
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain("smoke: FAIL the library answered 500");
		expect(run.calls.filter((call) => call === DELETE)).toHaveLength(1);
		expect(run.calls.at(-1)).toBe(DELETE);
		expect(run.calls).not.toContain("POST /api/copilotkit");
		expect(run.account).toBe(false);
	},
);

eachTwin(
	"an account that cannot be deleted is named, so the person can delete it",
	async (shell) => {
		const run = await smoke(shell, { erase: 500 });
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain(
			"smoke: FAIL deleting the smoke test's account answered 500",
		);
		expect(run.said).toContain(
			'smoke: the smoke test\'s account could not be deleted; it is the one named "Smoke test"',
		);
	},
);

eachTwin(
	"under entra nothing signs in, so nothing is deleted",
	async (shell) => {
		const run = await smoke(shell, { mode: "entra" });
		expect(run.exitCode).toBe(0);
		expect(run.said).toContain(
			"smoke: AUTH_MODE is entra, not local: signing in takes a person at the identity provider, so the checks stop here",
		);
		expect(run.calls).toEqual([
			"GET /health",
			"GET /login",
			"GET /api/conversations",
		]);
	},
);

for (const seed of ["false", "False", "FALSE"])
	eachTwin(
		`SEED_SAMPLE_LIBRARY=${seed} expects no sample document, as the deploy reads it`,
		async (shell) => {
			const run = await smoke(shell, { seed });
			expect(run.exitCode).toBe(0);
			expect(run.said).toContain(
				"smoke: ok   the library answers (SEED_SAMPLE_LIBRARY is false, so no document is expected)",
			);
		},
	);

eachTwin(
	"a sign-in whose answer broke off may have made the account: it is deleted on the way out",
	async (shell) => {
		const run = await smoke(shell, { signInBreaks: true });
		expect(run.exitCode).not.toBe(0);
		expect(run.calls.at(-2)).toBe("POST /api/auth/callback/local");
		expect(run.calls.at(-1)).toBe(DELETE);
		expect(run.account).toBe(false);
		expect(run.said).not.toContain("could not be deleted");
	},
);
