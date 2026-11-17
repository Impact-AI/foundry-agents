import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerOnly } from "./sign-in";

test("the backend is told which provider signed the person in, and none of the provider's tokens", () => {
	expect(
		providerOnly({
			provider: "microsoft-entra-id",
			access_token: "a",
			id_token: "i",
			refresh_token: "r",
		} as never),
	).toEqual({ provider: "microsoft-entra-id" });
	expect(providerOnly(null)).toBeNull();
	expect(providerOnly({} as never)).toBeNull();
});

test("the sign-in asks the provider for no refresh token: nothing here would use one", () => {
	const config = readFileSync(
		join(import.meta.dir, "..", "auth.config.ts"),
		"utf8",
	);
	expect(config).toContain('scope: "openid profile email"');
	expect(config).not.toContain("offline_access");
});
