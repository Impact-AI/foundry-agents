import { expect, test } from "bun:test";
import { assertDeploymentSafe } from "@platform/config/deployment-guard";
import { identityDeploymentRules } from "./deployment-rules";

const SECRET = "0123456789abcdef0123456789abcdef";
const DEPLOYED = { CONTAINER_APP_NAME: "backend", AUTH_SECRET: SECRET };

function problems(env: Record<string, string | undefined>): string {
	try {
		assertDeploymentSafe(identityDeploymentRules, env);
		return "";
	} catch (err) {
		return (err as Error).message;
	}
}

const HARDENED = { ...DEPLOYED, HARDENED: "True", AUTH_REQUIRE_ROLE: "1" };

test("a hardened deployment signs in through the provider only", () => {
	expect(problems({ ...HARDENED, AUTH_MODE: "entra" })).toBe("");
	expect(problems(HARDENED)).toBe("");
	expect(problems({ ...HARDENED, AUTH_MODE: "local" })).toContain(
		"AUTH_MODE is local",
	);
});

test("a hardened deployment admits by role, and a demo need not", () => {
	for (const off of [undefined, "", "0", "false"])
		expect(problems({ ...HARDENED, AUTH_REQUIRE_ROLE: off })).toContain(
			"AUTH_REQUIRE_ROLE is off",
		);
	expect(problems({ ...DEPLOYED, AUTH_REQUIRE_ROLE: "" })).toBe("");
});

test("a demo deployment may run the local sign-in; a mode that does not exist is refused", () => {
	expect(problems({ ...DEPLOYED, AUTH_MODE: "local" })).toBe("");
	expect(problems({ ...DEPLOYED, HARDENED: "0", AUTH_MODE: "local" })).toBe("");
	expect(problems({ ...DEPLOYED, AUTH_MODE: "open" })).toContain(
		"names no sign-in mode",
	);
});

test("no rule prints what a variable holds: a value pasted into the wrong one is not logged", () => {
	const pasted = "s3cr3t-pasted-into-the-wrong-variable";
	const said = [
		problems({ ...DEPLOYED, AUTH_MODE: pasted }),
		problems({ ...HARDENED, AUTH_MODE: "local", AUTH_REQUIRE_ROLE: "off" }),
		problems({ ...DEPLOYED, AUTH_SECRET: pasted.slice(0, 20) }),
	];
	expect(said[0]).toContain("AUTH_MODE names no sign-in mode");
	expect(said[1]).toContain("AUTH_REQUIRE_ROLE is off");
	for (const message of said) {
		expect(message).not.toContain(pasted);
		expect(message).not.toContain(pasted.slice(0, 20));
		// The rules' own lines: the frame around them is the guard's.
		const rules = message.split("\n").filter((l) => l.startsWith("  * "));
		expect(rules.length).toBeGreaterThan(0);
		for (const rule of rules) expect(rule).not.toContain('="');
	}
});

test("the secret is required, long enough to be one, never the vault's placeholder, and never printed", () => {
	expect(problems({ CONTAINER_APP_NAME: "backend" })).toContain("AUTH_SECRET");
	const short = problems({ ...DEPLOYED, AUTH_SECRET: "too-short-a-secret" });
	expect(short).toContain("shorter than 32");
	expect(short).not.toContain("too-short-a-secret");
	expect(problems({ ...DEPLOYED, AUTH_SECRET: "unset" })).toContain(
		"placeholder",
	);
	expect(problems({ ...DEPLOYED, AUTH_SECRET: ` ${SECRET} ` })).toBe("");
});

test("under the provider's sign-in, its settings are real values, never the vault's placeholder, and never printed", () => {
	const CLIENT = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
	const ISSUER =
		"https://login.microsoftonline.com/1a2b3c4d-0000-1111-2222-333344445555/v2.0";
	const SIGNED = {
		...DEPLOYED,
		AUTH_MODE: "entra",
		AUTH_MICROSOFT_ENTRA_ID_ID: CLIENT,
		AUTH_MICROSOFT_ENTRA_ID_SECRET: "a-real-client-secret-value",
		AUTH_MICROSOFT_ENTRA_ID_ISSUER: ISSUER,
	};
	expect(problems(SIGNED)).toBe("");
	// The backend is given none of the three, and is not refused for it.
	expect(problems({ ...DEPLOYED, AUTH_MODE: "entra" })).toBe("");
	const placeholder = problems({
		...SIGNED,
		AUTH_MICROSOFT_ENTRA_ID_SECRET: "unset",
	});
	expect(placeholder).toContain("AUTH_MICROSOFT_ENTRA_ID_SECRET");
	expect(placeholder).toContain("placeholder");
	expect(
		problems({ ...SIGNED, AUTH_MICROSOFT_ENTRA_ID_ID: "unset" }),
	).toContain("AUTH_MICROSOFT_ENTRA_ID_ID");
	expect(problems({ ...SIGNED, AUTH_MICROSOFT_ENTRA_ID_ISSUER: "" })).toContain(
		"AUTH_MICROSOFT_ENTRA_ID_ISSUER",
	);
	const notGuid = problems({ ...SIGNED, AUTH_MICROSOFT_ENTRA_ID_ID: "my-app" });
	expect(notGuid).toContain("client id");
	expect(notGuid).not.toContain("my-app");
	expect(
		problems({ ...SIGNED, AUTH_MICROSOFT_ENTRA_ID_ISSUER: "http://x" }),
	).toContain("https");
	// The local sign-in needs none of them.
	expect(
		problems({
			...SIGNED,
			AUTH_MODE: "local",
			AUTH_MICROSOFT_ENTRA_ID_SECRET: "unset",
		}),
	).toBe("");
	// Unset, the mode is the provider's.
	const { AUTH_MODE: _mode, ...unnamed } = SIGNED;
	expect(
		problems({ ...unnamed, AUTH_MICROSOFT_ENTRA_ID_SECRET: "unset" }),
	).toContain("placeholder");
});

test("nothing applies on a laptop", () => {
	expect(problems({ HARDENED: "true", AUTH_MODE: "local" })).toBe("");
});
