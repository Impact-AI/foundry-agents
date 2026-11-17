import { fakeConfigStore } from "@platform/config/testing";
import { setMeteringKeyPrefix, usageSubject } from "@platform/metering";
import { useLimits } from "@platform/metering/testing";
import { keyNamespace } from "@platform/redis";
import { resetVoiceSettings } from "../../settings";
import { type BrowserSocket, VoiceBroker } from "../broker";
import { stubHost } from "./stub-host";

/**
 * A replica that serves browser sockets and holds the sessions they open
 * until it is killed: the owner a test can take away without a goodbye, as
 * a crash or a scale-in past its grace does. It prints its port as one line
 * of JSON, and never ends on its own.
 *
 *   VOICE_TEST_ENDPOINT   the stand-in voice agent's project endpoint
 *   VOICE_TEST_PREFIX     the voice keys' namespace, shared with the test
 *   METERING_TEST_PREFIX  the ledger's prefix, shared with the test
 *   VOICE_TEST_OPEN       `{ subject, limits, voice }`
 *   VOICE_TEST_MODEL      a Voice Live model to bind to; unset, the voice agent
 */

const env = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const open = JSON.parse(env("VOICE_TEST_OPEN")) as {
	subject: string;
	limits: unknown;
	voice: unknown;
};
setMeteringKeyPrefix(env("METERING_TEST_PREFIX"));
useLimits(open.limits);
fakeConfigStore({ voice: open.voice });
resetVoiceSettings();

const subject = usageSubject(open.subject);
if (!subject) throw new Error("not a subject");
const broker = new VoiceBroker({
	// The runtime the test that spawned it binds to: Voice Live on a model, or the voice agent.
	host: stubHost(
		process.env.VOICE_TEST_MODEL
			? { voiceLive: { model: process.env.VOICE_TEST_MODEL } }
			: {},
	).host,
	namespace: keyNamespace(env("VOICE_TEST_PREFIX")),
	endpoint: () => env("VOICE_TEST_ENDPOINT"),
	token: async () => "test-token",
	enabled: true,
	surface: "test",
	replica: "replica-doomed",
	ownerTtlMs: 600,
});
const server = Bun.serve<BrowserSocket>({
	port: 0,
	fetch: (request, srv) =>
		broker.upgrade(request, srv, {
			voice: {
				subject,
				tier: "base",
				language: { code: "it", name: "Italian" },
			},
			resourceId: open.subject,
			identity: { oid: open.subject, groups: [], tier: "base" },
		}),
	websocket: broker.websocket,
});
console.log(JSON.stringify({ port: server.port }));
setInterval(() => {}, 60_000);
