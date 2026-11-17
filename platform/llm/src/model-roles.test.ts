import { afterEach, expect, test } from "bun:test";
import {
	defineModelRoles,
	deploymentName,
	ModelNotConfiguredError,
} from "./model-roles";

/** Two roles of a package that does not exist; the variables are this test's alone. */
const ROLES = defineModelRoles({
	left: { what: "The left model", envVar: "TEST_LEFT_DEPLOYMENT" },
	right: { what: "The right model", envVar: "TEST_RIGHT_DEPLOYMENT" },
});

afterEach(() => {
	for (const role of ROLES.names) delete process.env[ROLES.specs[role].envVar];
});

test("a blank name is absent, not a deployment named empty", () => {
	expect(deploymentName(undefined)).toBeUndefined();
	expect(deploymentName("")).toBeUndefined();
	expect(deploymentName("   ")).toBeUndefined();
	expect(deploymentName(42)).toBeUndefined();
	expect(deploymentName("  chat-eu  ")).toBe("chat-eu");
});

test("the environment names a role through its variable, trimmed, and a blank one names nothing", () => {
	process.env.TEST_LEFT_DEPLOYMENT = " left-eu ";
	process.env.TEST_RIGHT_DEPLOYMENT = "   ";
	expect(ROLES.fromEnvironment()).toEqual({ left: "left-eu" });
});

test("the table's refusal is the model error, naming the variable", () => {
	expect(() => ROLES.require({}, "right")).toThrow(ROLES.NotConfiguredError);
	try {
		ROLES.require({ left: "left-eu" }, "right");
		throw new Error("should have thrown");
	} catch (err) {
		expect(err).toBeInstanceOf(ModelNotConfiguredError);
		const e = err as ModelNotConfiguredError;
		expect(e.role).toBe("right");
		expect(e.message).toContain("TEST_RIGHT_DEPLOYMENT");
		expect(e.message).not.toContain("document");
	}
	expect(ROLES.require({ right: " right-eu " }, "right")).toBe("right-eu");
});
