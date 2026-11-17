import { Hono } from "hono";
import type { AppEnv } from "../auth/context";
import { refuse } from "./reply";

/**
 * The public routes, registered ahead of the gate: `/health`, the liveness
 * answer, which holds while the process runs; and `/ready`, the readiness
 * answer, which holds once the host has started and until the replica
 * begins to drain — so the platform stops sending it new traffic while the
 * live sessions it holds are told to reopen elsewhere.
 */
export function healthRoutes(
	ready: () => boolean,
	draining: () => boolean = () => false,
): Hono<AppEnv> {
	return new Hono<AppEnv>()
		.get("/health", (c) => c.text("ok"))
		.get("/ready", (c) =>
			draining()
				? refuse(c, 503, "draining")
				: ready()
					? c.text("ready")
					: refuse(c, 503, "starting"),
		);
}
