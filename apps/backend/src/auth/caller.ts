import { envString } from "@platform/config";
import { isProductionRuntime } from "@platform/config/deployment-guard";
import {
	callerAssertion,
	holdsUnderMode,
	LOCAL_PROVIDER_ID,
	LOCAL_ROLES,
	resolveAccess,
} from "@platform/identity";
import { usageSubject } from "@platform/metering";
import type { MiddlewareHandler } from "hono";
import { problems } from "../problems";
import { refuse } from "../routes/reply";
import type { AppEnv, Caller } from "./context";

/**
 * The gate: every request past `/health` carries a caller assertion the
 * frontend's server minted from its verified session, and the subject comes
 * from nowhere else; what the account gets is re-read from its row where it
 * is spent (`./standing`). With no `AUTH_SECRET`, outside the production
 * image and off a deployment, the gate stands open on one local account, so
 * a checkout needs no frontend secret to be called, and listens on the
 * loopback address only (`../index`); a production process without the secret never
 * starts (`identityDeploymentRules`), so no image built to serve can take the
 * bypass, wherever it runs.
 */
export function callerGateOpen(): boolean {
	return !envString("AUTH_SECRET") && !isProductionRuntime();
}

/** The one account an open gate serves, whoever signed in at the frontend: a local member like any other. */
export const OPEN_GATE_ACCOUNT_ID = `${LOCAL_PROVIDER_ID}:developer`;

function openGateCaller(): Caller {
	const roles = [...LOCAL_ROLES];
	return {
		sub: OPEN_GATE_ACCOUNT_ID,
		email: null,
		roles,
		groups: [],
		...resolveAccess(roles),
		// No session stands behind an open gate, so each call is its own: an erase of the one account shuts nobody out of a checkout.
		signedInAt: Math.floor(Date.now() / 1000) + 1,
	};
}

/** Who is calling, from the assertion, or null for none, malformed, expired or signed by somebody else. */
export async function callerOf(request: Request): Promise<Caller | null> {
	if (callerGateOpen()) return openGateCaller();
	const [scheme, token, ...rest] = (
		request.headers.get("authorization") ?? ""
	).split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0)
		return null;
	const caller = await callerAssertion.verify(token);
	return caller && holdsUnderMode(caller.sub) ? caller : null;
}

/** A caller whose account id cannot key a bucket is no caller: every scoped key is built from it. */
export const requireCaller: MiddlewareHandler<AppEnv> = async (c, next) => {
	const caller = await callerOf(c.req.raw);
	const subject = usageSubject(caller?.sub);
	if (!caller || !subject) {
		problems.report("backend.caller.unauthenticated", { status: 401 });
		return refuse(c, 401, "unauthenticated");
	}
	c.set("caller", caller);
	c.set("subject", subject);
	await next();
};
