import { afterEach, expect, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { callerGateOpen, callerOf, OPEN_GATE_ACCOUNT_ID } from "./caller";

/**
 * The open gate is for a checkout: no secret, no deployment, not the image
 * built to serve. Each of those alone keeps it shut.
 */
let restore = () => {};
afterEach(() => restore());

const CHECKOUT = {
	AUTH_SECRET: undefined,
	CONTAINER_APP_NAME: undefined,
	NODE_ENV: "development",
};

const anonymous = () => new Request("http://backend.test/identity/me");

test("a checkout with no secret serves its one local account", async () => {
	restore = scopedEnv(CHECKOUT);
	expect(callerGateOpen()).toBe(true);
	expect((await callerOf(anonymous()))?.sub).toBe(OPEN_GATE_ACCOUNT_ID);
});

test("the production image without the secret is shut wherever it runs, not only on Container Apps", async () => {
	for (const env of [
		{ ...CHECKOUT, NODE_ENV: "production" },
		{ ...CHECKOUT, CONTAINER_APP_NAME: "backend" },
		{ ...CHECKOUT, AUTH_SECRET: "s" },
	]) {
		restore = scopedEnv(env);
		try {
			expect(callerGateOpen()).toBe(false);
			expect(await callerOf(anonymous())).toBeNull();
		} finally {
			restore();
		}
	}
});
