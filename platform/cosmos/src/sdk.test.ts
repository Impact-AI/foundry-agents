import { expect, test } from "bun:test";
import type { Database } from "@azure/cosmos";
import { batchFailure, operationInput, sdkDatabase } from "./sdk";

test("a batch refused by one operation is refused with that operation's status, not the 424s of those rolled back with it", () => {
	expect(batchFailure([{ statusCode: 201 }, { statusCode: 200 }])).toBeNull();
	expect(
		batchFailure([
			{ statusCode: 424 },
			{ statusCode: 412 },
			{ statusCode: 424 },
		]),
	).toBe(412);
	expect(batchFailure([{ statusCode: 409 }, { statusCode: 424 }])).toBe(409);
});

/**
 * The wire shape of a patch inside a transactional batch is the object with
 * `operations`, never a bare array: the service answers an array with 400
 * "Field 'resourceBody' has unexpected value type", and the in-memory
 * stand-in, which never serializes anything, cannot tell the two apart.
 * This is the one place the shape is pinned.
 */
test("a batch patch carries { operations } as its resourceBody, with the condition inside it and the etag beside it", () => {
	const unconditional = operationInput({
		type: "patch",
		id: "v1",
		operations: [{ op: "set", path: "/isActive", value: false }],
		ifMatch: '"etag-1"',
	});
	expect(unconditional).toEqual({
		operationType: "Patch",
		id: "v1",
		resourceBody: {
			operations: [{ op: "set", path: "/isActive", value: false }],
		},
		ifMatch: '"etag-1"',
	});
	expect(
		Array.isArray((unconditional as { resourceBody: unknown }).resourceBody),
	).toBe(false);

	const conditional = operationInput({
		type: "patch",
		id: "v2",
		operations: [{ op: "set", path: "/isActive", value: true }],
		condition: "FROM c WHERE c.isActive = false",
	});
	expect(conditional).toEqual({
		operationType: "Patch",
		id: "v2",
		resourceBody: {
			operations: [{ op: "set", path: "/isActive", value: true }],
			condition: "FROM c WHERE c.isActive = false",
		},
	});

	expect(
		operationInput({ type: "create", document: { id: "v3", key: "persona" } }),
	).toEqual({
		operationType: "Create",
		resourceBody: { id: "v3", key: "persona" },
	});
});

/** A `Database` that records what reaches the SDK, answering every call as a success. */
function recordingDatabase() {
	const calls: { method: string; args: unknown[] }[] = [];
	const container = {
		items: {
			batch: async (...args: unknown[]) => {
				calls.push({ method: "items.batch", args });
				return { result: [{ statusCode: 200 }, { statusCode: 200 }] };
			},
		},
		item: (id: string, partitionKey: string) => ({
			patch: async (...args: unknown[]) => {
				calls.push({ method: `item(${id},${partitionKey}).patch`, args });
				return { resource: { id, _etag: '"next"' } };
			},
		}),
	};
	const database = { container: () => container } as unknown as Database;
	return { database, calls };
}

test("the container surface hands the SDK a batch of operations and a single patch's body in the same object shape", async () => {
	const { database, calls } = recordingDatabase();
	const docs = sdkDatabase(database).container("prompts");

	// The shape `activate` sends: switch one version off and another on, each guarded by its etag.
	await docs.batch("persona", [
		{
			type: "patch",
			id: "v1",
			operations: [{ op: "set", path: "/isActive", value: false }],
			ifMatch: '"etag-1"',
		},
		{
			type: "patch",
			id: "v2",
			operations: [{ op: "set", path: "/isActive", value: true }],
			ifMatch: '"etag-2"',
		},
	]);
	expect(calls[0]?.method).toBe("items.batch");
	expect(calls[0]?.args).toEqual([
		[
			{
				operationType: "Patch",
				id: "v1",
				resourceBody: {
					operations: [{ op: "set", path: "/isActive", value: false }],
				},
				ifMatch: '"etag-1"',
			},
			{
				operationType: "Patch",
				id: "v2",
				resourceBody: {
					operations: [{ op: "set", path: "/isActive", value: true }],
				},
				ifMatch: '"etag-2"',
			},
		],
		"persona",
	]);

	await docs.patch("v1", "persona", [{ op: "set", path: "/n", value: 2 }], {
		ifMatch: '"etag-1"',
		condition: "FROM c WHERE c.n = 1",
	});
	expect(calls[1]?.method).toBe("item(v1,persona).patch");
	expect(calls[1]?.args).toEqual([
		{
			operations: [{ op: "set", path: "/n", value: 2 }],
			condition: "FROM c WHERE c.n = 1",
		},
		{ accessCondition: { type: "IfMatch", condition: '"etag-1"' } },
	]);

	await docs.patch("v1", "persona", [{ op: "set", path: "/n", value: 3 }]);
	expect(calls[2]?.args).toEqual([
		{ operations: [{ op: "set", path: "/n", value: 3 }] },
		{},
	]);
});
