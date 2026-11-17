import { expect, test } from "bun:test";
import { MODEL_ROLES, requireDeployment } from "./deployment";
import { ModelNotConfiguredError } from "./model-roles";

test("requiring an unnamed role names the variable to set", () => {
	expect(() => requireDeployment({}, "chat")).toThrow(ModelNotConfiguredError);
	try {
		requireDeployment({ chat: "chat-eu" }, "embedding");
		throw new Error("should have thrown");
	} catch (err) {
		expect(err).toBeInstanceOf(ModelNotConfiguredError);
		const e = err as ModelNotConfiguredError;
		expect(e.role).toBe("embedding");
		expect(e.message).toContain(MODEL_ROLES.specs.embedding.envVar);
	}
	expect(requireDeployment({ chat: "chat-eu" }, "chat")).toBe("chat-eu");
});

test("no role borrows another's deployment", () => {
	const only = { chat: "chat-eu" };
	for (const role of ["smallChat", "embedding"] as const) {
		expect(() => requireDeployment(only, role)).toThrow(
			ModelNotConfiguredError,
		);
	}
});

test("every role names a distinct variable", () => {
	const vars = Object.values(MODEL_ROLES.specs).map((spec) => spec.envVar);
	expect(new Set(vars).size).toBe(vars.length);
});
