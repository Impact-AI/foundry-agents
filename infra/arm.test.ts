/**
 * Which Bicep CLI the compiled checks run on. Without one they skip; told
 * which one to use and unable to find it, they fail, so a run that names its
 * compiler never passes by skipping. And two rules of the expression language
 * the evaluator keeps as a deployment does, since a template that breaks
 * either compiles and fails only when it is deployed.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { allErrors, bicepCommand, instantiate } from "./arm";

test("a BICEP_CLI that names no file is an error, never a skip or another compiler", () => {
	const before = process.env.BICEP_CLI;
	try {
		process.env.BICEP_CLI = join(import.meta.dir, "no-such-bicep");
		expect(() => bicepCommand()).toThrow(/BICEP_CLI names .*no-such-bicep/);
		// Any file that exists is taken as the compiler it was said to be.
		process.env.BICEP_CLI = import.meta.path;
		expect(bicepCommand()).toEqual([import.meta.path]);
	} finally {
		if (before === undefined) delete process.env.BICEP_CLI;
		else process.env.BICEP_CLI = before;
	}
});

/** One resource whose name is the expression, in a template with the given parameters. */
function named(expression: string, parameters: Record<string, unknown>) {
	const declared = Object.fromEntries(
		Object.keys(parameters).map((name) => [name, { type: "object" }]),
	);
	const [resource] = instantiate(
		{
			parameters: declared,
			resources: [{ type: "Sample/things", name: expression }],
		},
		parameters,
	).resources;
	return { name: resource?.name, error: resource?.error };
}

test("a property an object does not have is an error on the resource that read it, and tryGet is the lenient read", () => {
	const item = { item: { userObjectId: "a" } };
	expect(named("[parameters('item').userObjectId]", item)).toEqual({
		name: "a",
		error: undefined,
	});
	expect(named("[parameters('item').name]", item).error).toContain(
		"no property 'name'",
	);
	expect(
		named("[coalesce(tryGet(parameters('item'), 'name'), 'fallback')]", item),
	).toEqual({ name: "fallback", error: undefined });
});

test("and and or stop at the argument that decides them", () => {
	const off = { config: {} };
	expect(
		named(
			"[if(and(contains(parameters('config'), 'enabled'), parameters('config').enabled), 'on', 'off')]",
			off,
		),
	).toEqual({ name: "off", error: undefined });
	expect(
		named(
			"[if(or(not(contains(parameters('config'), 'enabled')), parameters('config').enabled), 'on', 'off')]",
			off,
		),
	).toEqual({ name: "on", error: undefined });
});

test("null, a missing index and a missing key are refused as a deployment refuses them, each on the resource that read it", () => {
	const given = { nothing: null, list: ["a"], item: { id: "x" } };
	expect(named("[parameters('nothing').name]", given).error).toContain(
		"read of null",
	);
	expect(named("[parameters('list')[1]]", given).error).toContain(
		"outside an array of 1",
	);
	expect(named("[parameters('list').name]", given).error).toContain(
		"read of an array",
	);
	expect(named("[parameters('item')['missing']]", given).error).toContain(
		"no property 'missing'",
	);
	expect(named("[parameters('list')[0]]", given)).toEqual({
		name: "a",
		error: undefined,
	});
	expect(named("[parameters('item')['id']]", given)).toEqual({
		name: "x",
		error: undefined,
	});
});

test("a copy loop whose count cannot be evaluated, and an output that cannot, are errors of the deployment: neither is a resource to carry one", () => {
	const d = instantiate(
		{
			parameters: { item: { type: "object" } },
			resources: [
				{
					type: "Sample/things",
					name: "[format('thing-{0}', copyIndex())]",
					copy: { name: "things", count: "[parameters('item').count]" },
				},
			],
			outputs: {
				fine: { type: "string", value: "[parameters('item').id]" },
				broken: { type: "string", value: "[parameters('item').name]" },
			},
		},
		{ item: { id: "x" } },
	);
	expect(d.resources).toEqual([]);
	expect(d.outputs).toEqual({ fine: "x", broken: undefined });
	expect(allErrors(d)).toEqual([
		"0: the copy count: the object has no property 'count'",
		"output broken: the object has no property 'name'",
	]);
});

test("a property copy loop makes its input once for each index, and nothing for none", () => {
	const made = (items: string[]) =>
		instantiate(
			{
				parameters: { items: { type: "array" } },
				resources: [
					{
						type: "Sample/things",
						name: "thing",
						properties: {
							copy: [
								{
									name: "rules",
									count: "[length(parameters('items'))]",
									input: { value: "[parameters('items')[copyIndex('rules')]]" },
								},
							],
						},
					},
				],
			},
			{ items },
		).resources[0];
	const two = made(["a", "b"]);
	expect(two?.properties).toEqual({ rules: [{ value: "a" }, { value: "b" }] });
	expect(two?.error).toBeUndefined();
	// With no item there is no index to read, and nothing is read.
	const none = made([]);
	expect(none?.properties).toEqual({ rules: [] });
	expect(none?.error).toBeUndefined();
});
