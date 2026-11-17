import { parseTier, type Tier } from "./claims/access";
import { GROUPS_MAX } from "./claims/groups";
import { signCompact, verifyCompact } from "./claims/signed-token";
import { stringList } from "./claims/values";

/**
 * Short-lived signed assertions one service presents to another.
 *
 * A web app's server checks the session, decides, and attests to the result;
 * the service that receives the assertion verifies it before dispatching. It
 * is not the identity provider's token forwarded: that proves authentication,
 * and the decision here is authorization. Each purpose is its own label on
 * the compact token, so no assertion is usable as another.
 */

/** Every assertion is signed under this variable; the label tells the purposes apart. */
const SECRET_VAR = "AUTH_SECRET";

export interface AssertionPurpose<Claims extends object> {
	/** Domain separation for the key. Never reuse one. */
	label: string;
	issuer: string;
	audience: string;
	ttlSeconds: number;
	/** The claims off a verified payload, or `null` when they are not usable. */
	read: (payload: Record<string, unknown>) => Claims | null;
}

export interface Assertion<Claims extends object> {
	mint(
		claims: Claims,
		options?: { ttlSeconds?: number },
	): Promise<{ token: string; expiresAt: number }>;
	verify(token: string | null | undefined): Promise<Claims | null>;
}

export function defineAssertion<Claims extends object>(
	purpose: AssertionPurpose<Claims>,
): Assertion<Claims> {
	return {
		async mint(claims, options = {}) {
			const iat = Math.floor(Date.now() / 1000);
			const exp = iat + (options.ttlSeconds ?? purpose.ttlSeconds);
			const payload = {
				...claims,
				iss: purpose.issuer,
				aud: purpose.audience,
				iat,
				exp,
			};
			return {
				token: await signCompact(payload, SECRET_VAR, purpose.label),
				expiresAt: exp * 1000,
			};
		},
		async verify(token) {
			if (!token) return null;
			const payload = await verifyCompact(token, SECRET_VAR, purpose.label);
			if (!payload) return null;
			if (payload.iss !== purpose.issuer || payload.aud !== purpose.audience)
				return null;
			if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now())
				return null;
			return purpose.read(payload);
		},
	};
}

/** What a web app attests about the person behind a verified session. */
export interface CallerClaims {
	/** The account id. */
	sub: string;
	email: string | null;
	roles: string[];
	/** The identity provider's group ids, for access control at the level of a document. */
	groups: string[];
	tier: Tier;
	/**
	 * When the browser session behind the call was signed in, in seconds
	 * since the epoch; absent on an assertion no session stands behind. An
	 * erased account refuses every session that began before its erasure.
	 */
	signedInAt?: number;
}

/** Ten minutes: long enough that a client is not refetching constantly, stale by the time a leak is read. */
export const CALLER_ASSERTION_TTL_SECONDS = 600;

/** A web app's server → the backend, naming who is calling and what it decided they get. */
export const callerAssertion = defineAssertion<CallerClaims>({
	label: "caller-assertion:v1",
	issuer: "frontend",
	audience: "backend",
	ttlSeconds: CALLER_ASSERTION_TTL_SECONDS,
	read: (p) => {
		if (typeof p.sub !== "string" || p.sub.length === 0) return null;
		return {
			sub: p.sub,
			email: typeof p.email === "string" ? p.email : null,
			roles: stringList(p.roles),
			groups: stringList(p.groups).slice(0, GROUPS_MAX),
			// Anything but the literal premium reads as the lesser answer.
			tier: parseTier(p.tier),
			...(typeof p.signedInAt === "number" && Number.isFinite(p.signedInAt)
				? { signedInAt: p.signedInAt }
				: {}),
		};
	},
});

/** What a caller may touch: one memory scope. */
export interface ScopeClaims {
	rid: string;
}

/** Five minutes: minted per request, it only has to outlive clock skew between containers. */
export const SCOPE_ASSERTION_TTL_SECONDS = 300;

/** The backend (or a web app's server) → the agent, naming the one scope this request may touch. */
export const scopeAssertion = defineAssertion<ScopeClaims>({
	label: "scope-assertion:v1",
	issuer: "backend",
	audience: "agent",
	ttlSeconds: SCOPE_ASSERTION_TTL_SECONDS,
	read: (p) =>
		typeof p.rid === "string" && p.rid.length > 0 ? { rid: p.rid } : null,
});
