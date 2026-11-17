import { serveAgentRun } from "@platform/agent/agui";
import {
	getLimits,
	isUnmetered,
	keys,
	meterCall,
	rateLimitedResponse,
	refundCredits,
	rollingDay,
} from "@platform/metering";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppDeps } from "../app";
import type { AppEnv } from "../auth/context";
import { accessOf, requireStanding, stillAdmitted } from "../auth/standing";
import { languageOf } from "../language";
import { problems } from "../problems";

/**
 * The agent's run route, AG-UI over the host, for the frontend's runtime,
 * under the same gates as every other spend: the account's standing and its
 * daily chat allowance — then the host's own guards. Whose turn it is comes
 * from the verified assertion and nothing in the body: the subject it names
 * is the memory the turn reads and writes, and with the groups the
 * account's row holds — read by the standing gate, so a tool that decides
 * who may read what reads nothing a body could have written, nor what a
 * sign-in hours ago said — it is who is asking.
 *
 * The allowance is charged before the host reads the body, so a run the
 * host turns away before it starts — a body that is no run, a thread that
 * is somebody else's or busy, a turn already being answered — gets its
 * credit back: the day counts turns, not attempts.
 */
export function agentRoutes({
	host,
	product,
}: Pick<AppDeps, "host" | "product">): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();
	routes.post("/run", requireStanding, meterChat, async (c) => {
		const who = c.get("caller");
		const access = accessOf(c);
		const response = await serveAgentRun(host, c.req.raw, {
			resourceId: who.sub,
			surface: product.surfaces.web,
			languageName: languageOf(product.locales, c.req.raw.headers).name,
			caller: { oid: who.sub, groups: access.groups, tier: access.tier },
			stillAdmitted: stillAdmitted(c),
		});
		if (UNSTARTED.has(response.status) && !isUnmetered(access.tier))
			await refundCredits(
				keys.day(c.get("subject"), "chat"),
				rollingDay((await getLimits()).chat.perDay),
				1,
			);
		return response;
	});
	return routes;
}

/** The statuses of a run the host refused before it began: nothing was asked of a model. */
const UNSTARTED = new Set([400, 403, 409]);

const meterChat: MiddlewareHandler<AppEnv> = async (c, next) => {
	const { tier } = accessOf(c);
	const verdict = await meterCall(c.get("subject"), "chat", tier);
	if (!verdict.ok) {
		problems.report("backend.chat.rate_limited", {
			status: 429,
			surface: "chat",
			tier,
			retryAfterSeconds: verdict.refusal.retryAfterSeconds,
		});
		return rateLimitedResponse(verdict.refusal);
	}
	await next();
};
