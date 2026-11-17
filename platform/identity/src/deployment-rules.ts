import type { DeploymentRule } from "@platform/config/deployment-guard";
import { isOn } from "@platform/config/env";
import { AUTH_MODES, parseAuthMode } from "./claims/local";

/**
 * `AUTH_MODE` names a mode that exists, and `local` is never the mode of a
 * hardened deployment: `HARDENED` is the template's flag for one, and the
 * local sign-in has no identity provider behind it. What the variable holds
 * is never printed: a value pasted into the wrong variable would be logged
 * at every start.
 */
const signInMode: DeploymentRule = {
	check: (env) => {
		const raw = env.AUTH_MODE?.trim();
		if (!raw) return null;
		const mode = parseAuthMode(raw);
		if (!mode)
			return `AUTH_MODE names no sign-in mode — it is one of ${AUTH_MODES.join(", ")}.`;
		if (mode === "local" && isOn(env.HARDENED))
			return "AUTH_MODE is local — a hardened deployment signs people in through the identity provider only; set it to entra.";
		return null;
	},
};

/**
 * A hardened deployment admits by role. Sign-in through the provider is open
 * to everyone its tenant authenticates unless the registration requires
 * assignment, a switch in the tenant this code cannot see; `AUTH_REQUIRE_ROLE`
 * is the half it can hold.
 */
const roleGatedAdmission: DeploymentRule = {
	check: (env) =>
		isOn(env.HARDENED) && !isOn(env.AUTH_REQUIRE_ROLE)
			? "AUTH_REQUIRE_ROLE is off — a hardened deployment admits only a token carrying one of the app roles; set it to 1."
			: null,
};

/** Shorter than this a secret is a guess away: the template generates 64 characters. */
const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * The secret every assertion is signed under: present, long enough to be
 * one, and not the placeholder the template's vault stores for a secret
 * nobody supplied. The value is never printed.
 */
const signingSecret: DeploymentRule = {
	check: (env) => {
		const secret = env.AUTH_SECRET?.trim();
		if (!secret)
			return "AUTH_SECRET is missing or empty — it signs every assertion one service presents to another; without it nothing can be verified.";
		if (secret === "unset")
			return "AUTH_SECRET is the vault's placeholder for a secret nobody supplied — anyone who has read the template can sign with it; set a generated one.";
		if (secret.length < AUTH_SECRET_MIN_LENGTH)
			return `AUTH_SECRET is shorter than ${AUTH_SECRET_MIN_LENGTH} characters — it signs every assertion and the session; set a generated one.`;
		return null;
	},
};

/** A Microsoft Entra application (client) id: a GUID. */
const CLIENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider sign-in's own settings, where the app is given them: the
 * frontend reads them and the backend never does, so a process with none
 * of the three is not one this rule speaks for. Under the provider's
 * sign-in each must be a real value, never the vault's placeholder for one
 * nobody supplied, which would leave a deployment nobody can sign in to
 * while every check of its health passes. No value is printed.
 */
const providerSignIn: DeploymentRule = {
	check: (env) => {
		const names = [
			"AUTH_MICROSOFT_ENTRA_ID_ID",
			"AUTH_MICROSOFT_ENTRA_ID_SECRET",
			"AUTH_MICROSOFT_ENTRA_ID_ISSUER",
		] as const;
		if (names.every((name) => env[name] === undefined)) return null;
		if ((parseAuthMode(env.AUTH_MODE) ?? "entra") !== "entra") return null;
		const missing = names.filter((name) => {
			const value = env[name]?.trim();
			return !value || value === "unset";
		});
		if (missing.length)
			return `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty or the vault's placeholder — the provider's sign-in needs the app registration's values; run the provision again, or set them in the vault.`;
		if (!CLIENT_ID.test(env.AUTH_MICROSOFT_ENTRA_ID_ID?.trim() ?? ""))
			return "AUTH_MICROSOFT_ENTRA_ID_ID is not an application id — it is the registration's client id, a GUID.";
		if (!/^https:\/\//.test(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER?.trim() ?? ""))
			return "AUTH_MICROSOFT_ENTRA_ID_ISSUER is not an https address — it is the tenant's issuer, https://login.microsoftonline.com/<tenant>/v2.0.";
		return null;
	},
};

/** The rules this package owns, for an app to pass to `assertDeploymentSafe`. */
export const identityDeploymentRules: readonly DeploymentRule[] = [
	signingSecret,
	signInMode,
	roleGatedAdmission,
	providerSignIn,
];
