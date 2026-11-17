import { edgeLimits } from "@platform/http";
import {
	ACCOUNT_UNAVAILABLE,
	type Account,
	type AccountLike,
	accountAccess,
	PERSON_NAME_MAX,
	PERSON_TEXT_MAX,
	type PersonPatch,
	resolveSignIn,
	type SignInInput,
	signInAccountId,
	standingRefusal,
	type TokenClaims,
	type UserLike,
	updatePerson,
} from "@platform/identity";
import { Hono } from "hono";
import type { AppDeps } from "../app";
import { callerGateOpen } from "../auth/caller";
import type { AppEnv } from "../auth/context";
import { readingOf, refuseAccountGone } from "../auth/standing";
import { problems } from "../problems";
import { NO_STORE, readObject, refuse } from "./reply";

/**
 * Sign-in is the frontend's; the row is the backend's. The frontend's
 * Auth.js callback reports what the provider said, under an assertion
 * minted from those same claims, and this answers `resolveSignIn`'s
 * outcome: the subject, the roles and the groups the row records are the
 * assertion's, so nothing a body carries can grant itself access. `/me` is the person and their account: the fields they edit,
 * access and groups re-resolved from the row — the session carries a
 * snapshot, never the authorization — and three facts of this deployment
 * beside them: the agent's id, the body limit the edge enforces, and the
 * controls the interface registers for the agent to drive, so a client in
 * front of this one holds none of them as configuration of its own.
 *
 * `/me/memory` is what the agent remembers about the person, a statement at
 * a time, theirs to read, correct and remove, one by one or all at once:
 * the right to rectification, made a route. Neither it
 * nor the edit asks standing — deactivation shuts the product, not the
 * rights.
 */

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function signInInputOf(
	body: Record<string, unknown> | null,
): SignInInput | null {
	if (!body) return null;
	return {
		claims: record(body.claims) as TokenClaims,
		user: record(body.user) as UserLike,
		account: record(body.account) as AccountLike,
	};
}

function text(value: unknown, max: number): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" && value.length <= max ? value : undefined;
}

/** The fields a body carries, each checked; null for a body that carries none, or one it cannot. */
function readPersonPatch(
	body: Record<string, unknown> | null,
): PersonPatch | null {
	if (!body) return null;
	const patch: PersonPatch = {};
	if ("name" in body) {
		const name = text(body.name, PERSON_NAME_MAX);
		if (!name?.trim()) return null;
		patch.name = name;
	}
	for (const key of ["about", "preferences"] as const) {
		if (!(key in body)) continue;
		const value = text(body[key], PERSON_TEXT_MAX);
		if (value === undefined) return null;
		patch[key] = value;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

/** Past any statement a person would write; the host caps what it keeps far lower. */
const MEMORY_ITEM_MAX = 10_000;

function personOf(account: Account) {
	return {
		name: account.name,
		about: account.about,
		preferences: account.preferences,
	};
}

export function identityRoutes({
	host,
	product,
}: Pick<AppDeps, "host" | "product">): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.post("/sign-in", async (c) => {
		const input = signInInputOf(await readObject(c));
		if (!input) return refuse(c, 400, "invalid_body");
		const { sub, roles, groups } = c.get("caller");
		// An open gate serves its one account whoever signed in, so the sign-in
		// lands on it; otherwise a caller may report its own sign-in and nobody
		// else's, and what the provider said of its roles and groups is read
		// from the assertion the frontend signed, never from the body beside it.
		const reported = callerGateOpen()
			? { ...input, user: { ...input.user, id: sub } }
			: { ...input, claims: { ...input.claims, roles, groups } };
		if (signInAccountId(reported) !== sub) {
			problems.report("backend.caller.forbidden", {
				status: 403,
				surface: "sign-in",
			});
			return refuse(c, 403, "forbidden");
		}
		// An erase left begun and never finished is finished by the sign-in that finds it.
		const outcome = await resolveSignIn(reported, {
			sweep: (accountId, stillHeld) =>
				host.eraseResource(accountId, { stillHeld }),
		});
		return c.json(outcome, 200, NO_STORE);
	});

	routes.get("/me", async (c) => {
		const [{ standing, account }, { maxRequestBodyBytes }] = await Promise.all([
			readingOf(c),
			edgeLimits().read(),
		]);
		if (!account)
			return standing === "unknown"
				? refuse(c, 503, ACCOUNT_UNAVAILABLE)
				: refuse(c, 404, "no_account");
		const { groups, ...access } = accountAccess(account);
		const refusal = standingRefusal(standing);
		return c.json(
			{
				accountId: account.id,
				...personOf(account),
				access,
				groups,
				standing: refusal ?? "ok",
				agentId: product.agentId,
				limits: { maxRequestBodyBytes },
				stageTools: product.clientTools ?? [],
			},
			200,
			NO_STORE,
		);
	});

	routes.patch("/me", async (c) => {
		const patch = readPersonPatch(await readObject(c));
		if (!patch) return refuse(c, 400, "invalid_body");
		// Lands only on the account the gate admitted this request on: its body may arrive after an erase and the sign-in after it.
		const admitted = (await readingOf(c)).account;
		const account = await updatePerson(c.get("caller").sub, patch, admitted);
		if (!account)
			return admitted ? refuseAccountGone(c) : refuse(c, 404, "no_account");
		await host.personChanged(account.id);
		return c.json(personOf(account), 200, NO_STORE);
	});

	routes.get("/me/memory", async (c) =>
		c.json(await host.readMemory(c.get("caller").sub), 200, NO_STORE),
	);

	routes.patch("/me/memory/:id", async (c) => {
		const body = await readObject(c);
		if (
			typeof body?.content !== "string" ||
			!body.content.trim() ||
			body.content.length > MEMORY_ITEM_MAX
		)
			return refuse(c, 400, "invalid_body");
		const item = await host.updateMemoryItem(
			c.get("caller").sub,
			c.req.param("id"),
			body.content,
		);
		return item ? c.json(item, 200, NO_STORE) : refuse(c, 404, "not_found");
	});

	routes.delete("/me/memory/:id", async (c) =>
		(await host.removeMemoryItem(c.get("caller").sub, c.req.param("id")))
			? c.body(null, 204)
			: refuse(c, 404, "not_found"),
	);

	routes.delete("/me/memory", async (c) => {
		await host.forgetMemory(c.get("caller").sub);
		return c.body(null, 204);
	});

	return routes;
}
