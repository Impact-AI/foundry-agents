import { parseTier } from "@platform/identity/claims";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { holdsSession } from "@/auth.config";
import type { Caller } from "./backend/client";
import { getUserLocale } from "./i18n/locale";
import type { Locale } from "./i18n/locales";

/**
 * The session draws the interface; it never authorizes. The claims it carries
 * are the snapshot baked at sign-in, and everything that costs something is
 * re-resolved by the backend against the database on every call.
 */
export function callerFromSession(
	session: Session | null | undefined,
	locale: Locale,
): Caller | null {
	if (!session || !holdsSession(session)) return null;
	const { user } = session;
	return {
		claims: {
			sub: user.id,
			email: user.email ?? null,
			roles: user.roles ?? [],
			groups: user.groups ?? [],
			tier: parseTier(user.tier),
			...(typeof user.signedInAt === "number"
				? { signedInAt: user.signedInAt }
				: {}),
		},
		locale,
	};
}

/** The verified caller behind this request, in this request's language, or null when nobody is signed in on a session that holds. */
export async function readCaller(): Promise<Caller | null> {
	const [session, locale] = await Promise.all([auth(), getUserLocale()]);
	return callerFromSession(session, locale);
}

/** For pages: the caller, or the door. */
export async function requireCaller(): Promise<Caller> {
	const caller = await readCaller();
	if (!caller) redirect("/login");
	return caller;
}

/** What a page may show about the account; drawn from the session, never authorized from it. */
export async function readAccountView(): Promise<{
	name: string | null;
	email: string | null;
	tier: "base" | "premium";
} | null> {
	const session = await auth();
	if (!session || !holdsSession(session)) return null;
	const { user } = session;
	return {
		name: user.name ?? null,
		email: user.email ?? null,
		tier: parseTier(user.tier),
	};
}
