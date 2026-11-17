import { afterEach, expect, test } from "bun:test";
import { assertDeploymentSafe } from "@platform/config/deployment-guard";
import { scopedEnv } from "@platform/test-support";
import type { Session } from "next-auth";
import type { CredentialsConfig } from "next-auth/providers/credentials";
import {
	buildAuthConfig,
	holdsSession,
	SESSION_MAX_AGE_SECONDS,
} from "./auth.config";
import { ENTRA_PROVIDER_ID, LOCAL_PROVIDER_ID } from "./src/auth-providers";
import { door } from "./src/door";
import { identityDeploymentRules } from "./src/identity";

/**
 * The Auth.js config, called as Auth.js calls it: which provider each mode
 * registers, what a sign-in bakes onto the token, how long the token lasts,
 * what the session reads back, which sessions the proxy lets through, and
 * the deployment rule that keeps the local sign-in off a hardened
 * deployment.
 */
type Callbacks = ReturnType<typeof buildAuthConfig>["callbacks"];
type JwtParams = Parameters<Callbacks["jwt"]>[0];
type SessionParams = Parameters<Callbacks["session"]>[0];

const entra = buildAuthConfig("entra");
const local = buildAuthConfig("local");

let restore = () => {};
afterEach(() => restore());

/** What Auth.js runs: a provider's defaults with the options it was built from merged over them. */
function effective<T extends object>(provider: T): T {
	return { ...provider, ...(provider as { options?: Partial<T> }).options };
}

test("each mode registers the one provider it names", () => {
	expect(entra.providers.map((p) => effective(p).id)).toEqual([
		ENTRA_PROVIDER_ID,
	]);
	expect(local.providers.map((p) => effective(p).id)).toEqual([
		LOCAL_PROVIDER_ID,
	]);
});

test("an entra sign-in bakes the subject, the roles and the groups onto the token, and the session reads them back as access", async () => {
	const token = await entra.callbacks.jwt({
		token: { sub: "sub-1" },
		user: { id: "sub-1", email: "ada@example.com" },
		account: {
			provider: ENTRA_PROVIDER_ID,
			providerAccountId: "sub-1",
			type: "oidc",
		},
		// Auth.js names the token's claims `profile`; the callbacks read them as claims.
		profile: { oid: "oid-1", roles: ["premium"], groups: ["g-1"] },
	} as JwtParams);
	expect(token).toMatchObject({
		sub: "oid-1",
		roles: ["premium"],
		groups: ["g-1"],
	});
	const session = await entra.callbacks.session({
		session: { user: { email: "ada@example.com" }, expires: "" },
		token,
	} as SessionParams);
	expect(session.user).toMatchObject({
		id: "oid-1",
		roles: ["premium"],
		groups: ["g-1"],
		tier: "premium",
	});
});

test("a session lasts a bounded time from its sign-in however often it is read, so the next sign-in refreshes what the provider says", async () => {
	expect(SESSION_MAX_AGE_SECONDS).toBeLessThanOrEqual(12 * 60 * 60);
	expect(entra.session.maxAge).toBe(SESSION_MAX_AGE_SECONDS);
	const now = Math.floor(Date.now() / 1000);
	const read = (token: Record<string, unknown>) =>
		entra.callbacks.jwt({ token } as JwtParams);
	const fresh = { sub: "oid-1", signedInAt: now - 60 };
	expect(await read(fresh)).toEqual(fresh);
	expect(
		await read({ sub: "oid-1", signedInAt: now - SESSION_MAX_AGE_SECONDS }),
	).toBeNull();
	// A token minted before the bound existed carries no sign-in time, and ends.
	expect(await read({ sub: "oid-1" })).toBeNull();
});

test("the local provider signs a name in as a new member account every time, and refuses a name that is not one", async () => {
	const provider = effective(local.providers[0] as CredentialsConfig);
	const request = new Request("http://frontend.test/api/auth/callback/local");
	const first = (await provider.authorize({ name: " Ada " }, request)) as {
		id: string;
	};
	expect(first).toMatchObject({ name: "Ada", email: null });
	expect(first.id.startsWith("local:")).toBe(true);
	const second = (await provider.authorize({ name: "Ada" }, request)) as {
		id: string;
	};
	expect(second.id).not.toBe(first.id);
	expect(await provider.authorize({ name: "" }, request)).toBeNull();
	expect(await provider.authorize({}, request)).toBeNull();

	for (const name of ["Ada", "admin"]) {
		const user = (await provider.authorize({ name }, request)) as {
			id: string;
			name: string;
		};
		const token = await local.callbacks.jwt({
			token: {},
			user,
			account: {
				provider: LOCAL_PROVIDER_ID,
				providerAccountId: user.id,
				type: "credentials",
			},
		} as JwtParams);
		expect(token).toMatchObject({ sub: user.id, roles: ["user"], groups: [] });
	}
});

const sessionOf = (id: string) =>
	({
		user: { id, roles: [], groups: [], tier: "base" },
		expires: "",
	}) as Session | null;

test("a local session left over from a switch to entra is nobody to the proxy, as to every page, so the door does not bounce it", () => {
	restore = scopedEnv({ AUTH_MODE: "entra" });
	const stale = sessionOf("local:3f0c1d2e-0000-4000-8000-000000000000");
	expect(holdsSession(stale)).toBe(false);
	const page = door(stale, new URL("https://app.test/chat?t=1"));
	expect(page.status).toBe(307);
	expect(page.headers.get("location")).toBe(
		"https://app.test/login?callbackUrl=%2Fchat%3Ft%3D1",
	);
	expect(door(stale, new URL("https://app.test/api/chat")).status).toBe(401);
	expect(
		door(stale, new URL("https://app.test/login")).headers.get(
			"x-middleware-next",
		),
	).toBe("1");

	const held = sessionOf("oid-1");
	expect(holdsSession(held)).toBe(true);
	expect(
		door(held, new URL("https://app.test/chat")).headers.get(
			"x-middleware-next",
		),
	).toBe("1");
	expect(holdsSession(null)).toBe(false);
});

test("the login page's client chunk names the providers by id and carries neither them nor the claim rules", async () => {
	const imports = async (path: string) =>
		new Bun.Transpiler({ loader: "tsx" })
			.scanImports(await Bun.file(new URL(path, import.meta.url)).text())
			.map((i) => i.path);
	const form = await imports("./app/login/LoginForm.tsx");
	expect(form).toContain("@/src/auth-providers");
	expect(form).not.toContain("@/auth.config");
	expect(form.filter((p) => p.startsWith("@platform/"))).toEqual([]);
	expect(await imports("./src/auth-providers.ts")).toEqual([
		"@platform/identity/claims/provider",
	]);
});

test("a hardened deployment refuses to start in local mode", () => {
	const deployed = {
		CONTAINER_APP_NAME: "frontend",
		AUTH_SECRET: "a-secret-long-enough-for-a-deployment",
		AUTH_REQUIRE_ROLE: "1",
	};
	expect(() =>
		assertDeploymentSafe(identityDeploymentRules, {
			...deployed,
			HARDENED: "true",
			AUTH_MODE: "local",
		}),
	).toThrow("AUTH_MODE is local");
	expect(() =>
		assertDeploymentSafe(identityDeploymentRules, {
			...deployed,
			AUTH_MODE: "local",
		}),
	).not.toThrow();
});
