import type {
	BrowserSocket,
	LiveCaller,
	VoiceBroker,
	VoiceCaller,
} from "@platform/voice";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth/context";
import { accessOf, requireStanding, stillAdmitted } from "../auth/standing";
import type { BackendProduct } from "../backend-product";
import { languageOf } from "../language";
import { NO_STORE } from "./reply";
import { sessionTuningOf, voiceTuningRoutes } from "./voice-tuning";

interface VoiceDeps {
	broker: VoiceBroker;
	product: BackendProduct;
}

/**
 * The microphone's routes, each handed to the voice package with a caller
 * this app verified: the subject from the assertion, the tier from the row
 * at the point of use, the language by the app's one resolution order. The
 * capability shapes what is offered and authorizes nothing.
 *
 * The live session is one WebSocket (`@platform/voice`'s `VoiceBroker`):
 * `GET /voice/live` upgraded behind the same gate and standing check as
 * every spending route, so the account's row is read before the socket is
 * accepted. Everything after — the thread, the audio, the stage's answers,
 * the end — crosses that socket, and the replica that accepted it holds the
 * session. `env` is Bun's server, which only a real listener has: a request
 * that is not an upgrade, or one with no server to upgrade it, is 426.
 * A voice tester's saved tuning rides with the caller, checked again as the
 * socket is accepted (`voice-tuning.ts`); `/voice/tuning` is where they
 * save it.
 */
export function voiceRoutes({ broker, product }: VoiceDeps): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.get("/capability", (c) => c.json(broker.capability(), 200, NO_STORE));

	const spending = new Hono<AppEnv>();
	spending.use("*", requireStanding);

	spending.get("/live", async (c) =>
		broker.upgrade(
			c.req.raw,
			c.env as Bun.Server<BrowserSocket> | undefined,
			await liveCallerOf(c, product),
		),
	);
	spending.route("/tuning", voiceTuningRoutes());

	routes.route("/", spending);
	return routes;
}

function voiceCallerOf(
	c: Context<AppEnv>,
	{ surfaces, locales }: BackendProduct,
): VoiceCaller {
	const surface = surfaces.live;
	return {
		subject: c.get("subject"),
		tier: accessOf(c).tier,
		language: languageOf(locales, c.req.raw.headers),
		surface,
	};
}

/** The account the session reads and writes, who is asking, and a voice tester's tuning, from the verified assertion and the row. */
async function liveCallerOf(
	c: Context<AppEnv>,
	product: BackendProduct,
): Promise<LiveCaller> {
	const who = c.get("caller");
	const access = accessOf(c);
	return {
		voice: voiceCallerOf(c, product),
		resourceId: who.sub,
		identity: { oid: who.sub, groups: access.groups, tier: access.tier },
		tuning: await sessionTuningOf(c.get("account") ?? null, access.tier),
		stillAdmitted: stillAdmitted(c),
	};
}
