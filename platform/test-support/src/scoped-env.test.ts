import { expect, test } from "bun:test";
import { scopedEnv } from "./scoped-env";

const SET = "SCOPED_ENV_TEST_SET";
const UNSET = "SCOPED_ENV_TEST_UNSET";

test("a value is set and an undefined is unset, and the restore puts both back", () => {
	process.env[SET] = "before";
	delete process.env[UNSET];
	const restore = scopedEnv({ [SET]: undefined, [UNSET]: "during" });
	expect(process.env[SET]).toBeUndefined();
	expect(process.env[UNSET]).toBe("during");
	restore();
	expect(process.env[SET]).toBe("before");
	expect(UNSET in process.env).toBe(false);
	delete process.env[SET];
});

test('unsetting never writes the string "undefined"', () => {
	const restore = scopedEnv({ [UNSET]: undefined });
	expect(process.env[UNSET]).not.toBe("undefined");
	restore();
});
