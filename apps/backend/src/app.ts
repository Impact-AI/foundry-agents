import type { AgentHost } from "@platform/agent";
import { edgeLimits, keepStreamAlive } from "@platform/http";
import { getLimits } from "@platform/metering";
import type { VoiceBroker } from "@platform/voice";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireCaller } from "./auth/caller";
import type { AppEnv } from "./auth/context";
import { judgedOnArrival, refuseErasedSession } from "./auth/standing";
import type { BackendProduct } from "./backend-product";
import { accountRoutes } from "./routes/account";
import { agentRoutes } from "./routes/agent";
import { appearanceRoutes } from "./routes/appearance";
import { conversationRoutes } from "./routes/conversations";
import { healthRoutes } from "./routes/health";
import { identityRoutes } from "./routes/identity";
import { mediaRoutes } from "./routes/media";
import { refuse } from "./routes/reply";
import { voiceRoutes } from "./routes/voice";

export interface AppDeps {
	host: AgentHost;
	product: BackendProduct;
	/** Live voice, relayed: the sessions whose sockets this replica holds. */
	broker: VoiceBroker;
	/** Whether the host has started; until it has, everything past the public routes is 503. Always, when absent. */
	ready?: () => boolean;
}

/**
 * One bound on every body, before any route reads one: what the edge in
 * front of the deployment accepts. Without it a body is held only to the
 * runtime's own ceiling of 128 MB; a body that names no length is counted
 * as it arrives.
 */
const boundedBody: MiddlewareHandler<AppEnv> = async (c, next) =>
	bodyLimit({
		maxSize: (await edgeLimits().read()).maxRequestBodyBytes,
		onError: (c) => refuse(c, 413, "body_too_large"),
	})(c, next);

/**
 * The app, composed from the routes in one order: the keep-alive on every
 * answer, the public routes (health, and the deployment's appearance), the wait for the host, the gate, the refusal
 * of a session its account's erasure ended, the body bound, and a request
 * that may write judged again once its body has arrived, then everything
 * they cover — an unknown path is answered 401 before it is answered 404,
 * a body is read only for a caller the gate let in, and no route writes
 * for a request whose account is no longer the one it was admitted on.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		// The route, never the path: a path carries a thread's or a document's id.
		console.error(`[backend] ${c.req.method} ${c.req.routePath} failed:`, err);
		return refuse(c, 500, "internal");
	});
	app.use("*", async (c, next) => {
		await next();
		c.res = keepStreamAlive(c.res);
	});

	const ready = deps.ready ?? (() => true);
	// A replica draining its live sessions is not ready for new traffic, and still serves what it has.
	app.route(
		"/",
		healthRoutes(ready, () => deps.broker.draining),
	);
	// The deployment's look and its logo: the sign-in door wears them before anybody has signed in.
	app.route("/", appearanceRoutes(deps.product.locales));
	app.use("*", async (c, next) =>
		ready() ? next() : refuse(c, 503, "starting"),
	);
	app.use("*", requireCaller);
	app.use("*", refuseErasedSession);
	app.use("*", boundedBody);
	app.use("*", judgedOnArrival);
	app.notFound((c) => refuse(c, 404, "not_found"));

	app.route("/identity", identityRoutes(deps));
	app.route("/conversations", conversationRoutes(deps));
	app.route("/media", mediaRoutes());
	deps.product.routes?.(app);
	app.route("/voice", voiceRoutes(deps));
	app.route("/account", accountRoutes(deps.host));
	app.route("/agent", agentRoutes(deps));
	// The cold costs of the first turn, paid while the person is still arriving. Coalesced by the host.
	app.get("/warm", async (c) => {
		await Promise.all([deps.host.warmUp(), getLimits()]);
		return c.body(null, 204);
	});
	return app;
}
