import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	ContainerDefinition,
	CosmosDocument,
	DocumentContainer,
} from "../container";
import { emulatorRequested, openTestCosmos, type TestCosmos } from "./open";

/**
 * What the stores rely on Cosmos DB to do, asserted against the container
 * surface alone, once in memory and once on the emulator: the in-memory
 * stand-in passes here, and in CI the emulator passes the same cases, so the
 * stand-in every other suite runs on answers as the service does. A case the
 * emulator fails is a gap to record against the real service, never a case
 * to loosen.
 */

const DOCS: ContainerDefinition = {
	name: "contract",
	partitionKey: "/pk",
	compositeIndexes: [
		[
			{ path: "/rank", order: "descending" },
			{ path: "/id", order: "descending" },
		],
	],
};

interface Doc extends CosmosDocument {
	pk: string;
	[field: string]: unknown;
}

/** A partition no other case writes to. */
const partition = () => `p-${crypto.randomUUID().slice(0, 8)}`;

const refusedWith = (statusCode: number) =>
	expect.objectContaining({ statusCode });

export function cosmosContract(emulator: boolean): void {
	const target = emulator ? "emulator" : "memory";
	describe.skipIf(emulator && !emulatorRequested())(
		`the container surface (${target})`,
		() => {
			let cosmos: TestCosmos;
			let docs: DocumentContainer;

			beforeAll(async () => {
				cosmos = await openTestCosmos([DOCS], emulator);
				docs = cosmos.database.container(DOCS.name);
			});
			afterAll(async () => {
				await cosmos?.drop();
			});

			test("a document is read in its own partition only, and an id is unique within a partition, not across them", async () => {
				const [p1, p2] = [partition(), partition()];
				const created = await docs.create<Doc>({ id: "a", pk: p1, n: 1 });
				expect(created).toMatchObject({ id: "a", pk: p1, n: 1 });
				expect(created._etag).toBeString();
				expect(await docs.read<Doc>("a", p1)).toMatchObject({ n: 1 });
				expect(await docs.read("a", p2)).toBeNull();
				expect(await docs.read("b", p1)).toBeNull();
				await expect(docs.create({ id: "a", pk: p1, n: 2 })).rejects.toEqual(
					refusedWith(409),
				);
				expect(await docs.create<Doc>({ id: "a", pk: p2 })).toMatchObject({
					pk: p2,
				});
				expect(await docs.read<Doc>("a", p1)).toMatchObject({ n: 1 });
			});

			test("a patch sets fields and stamps a new etag; a stale etag or a false condition is refused and writes nothing", async () => {
				const pk = partition();
				const first = await docs.create<Doc>({ id: "d", pk, n: 1 });
				const patched = await docs.patch<Doc>("d", pk, [
					{ op: "set", path: "/n", value: 2 },
					{ op: "set", path: "/name", value: null },
				]);
				expect(patched).toMatchObject({ n: 2, name: null });
				expect(patched?._etag).not.toBe(first._etag);
				await expect(
					docs.patch("d", pk, [{ op: "set", path: "/n", value: 3 }], {
						ifMatch: first._etag,
					}),
				).rejects.toEqual(refusedWith(412));
				expect(
					await docs.patch<Doc>(
						"d",
						pk,
						[{ op: "set", path: "/n", value: 4 }],
						{
							ifMatch: patched?._etag,
						},
					),
				).toMatchObject({ n: 4 });

				// A field filled only while it holds nothing: null and absent alike.
				const unnamed =
					"FROM c WHERE NOT IS_DEFINED(c.name) OR IS_NULL(c.name)";
				const fill = (value: string) =>
					docs.patch<Doc>("d", pk, [{ op: "set", path: "/name", value }], {
						condition: unnamed,
					});
				expect(await fill("Ada")).toMatchObject({ name: "Ada" });
				await expect(fill("Bea")).rejects.toEqual(refusedWith(412));
				expect(await docs.read<Doc>("d", pk)).toMatchObject({
					name: "Ada",
					n: 4,
				});
				await docs.create<Doc>({ id: "e", pk });
				expect(
					await docs.patch<Doc>(
						"e",
						pk,
						[{ op: "set", path: "/name", value: "Cy" }],
						{
							condition: unnamed,
						},
					),
				).toMatchObject({ name: "Cy" });

				expect(
					await docs.patch("missing", pk, [
						{ op: "set", path: "/n", value: 1 },
					]),
				).toBeNull();
			});

			test("a delete answers whether there was a document to delete", async () => {
				const pk = partition();
				await docs.create<Doc>({ id: "gone", pk });
				expect(await docs.delete("gone", pk)).toBe(true);
				expect(await docs.read("gone", pk)).toBeNull();
				expect(await docs.delete("gone", pk)).toBe(false);
			});

			test("a query answers one partition, by its parameters, in the order asked; a keyset pages it", async () => {
				const [pk, other] = [partition(), partition()];
				for (const [id, rank] of [
					["a", 3],
					["b", 1],
					["c", 2],
					["d", 2],
				] as const)
					await docs.create<Doc>({ id, pk, rank, kind: "row" });
				await docs.create<Doc>({
					id: "flagged",
					pk,
					rank: 9,
					kind: "row",
					flag: true,
				});
				await docs.create<Doc>({ id: "a", pk: other, rank: 5, kind: "row" });
				const ids = (rows: CosmosDocument[]) => rows.map((r) => r.id);
				const newestFirst = "ORDER BY c.rank DESC, c.id DESC";

				expect(
					ids(
						await docs.query(
							{
								query: `SELECT * FROM c WHERE c.kind = @kind AND NOT IS_DEFINED(c.flag) ${newestFirst}`,
								parameters: [{ name: "@kind", value: "row" }],
							},
							pk,
						),
					),
				).toEqual(["a", "d", "c", "b"]);
				// A field a document lacks compares to undefined: it is not false, and not kept.
				expect(
					ids(
						await docs.query(
							{ query: "SELECT * FROM c WHERE c.flag = true" },
							pk,
						),
					),
				).toEqual(["flagged"]);
				expect(
					ids(
						await docs.query(
							{ query: "SELECT * FROM c WHERE c.flag != true" },
							pk,
						),
					),
				).toEqual([]);

				const page = (rank: number, id: string) =>
					docs.query(
						{
							query: `SELECT * FROM c WHERE c.rank < 9 AND (c.rank < @rank OR (c.rank = @rank AND c.id < @id)) ${newestFirst} OFFSET 0 LIMIT 2`,
							parameters: [
								{ name: "@rank", value: rank },
								{ name: "@id", value: id },
							],
						},
						pk,
					);
				expect(ids(await page(9, ""))).toEqual(["a", "d"]);
				expect(ids(await page(2, "d"))).toEqual(["c", "b"]);
				expect(ids(await page(1, "b"))).toEqual([]);
				expect(
					ids(
						await docs.query(
							{ query: `SELECT TOP 1 * FROM c ${newestFirst}` },
							pk,
						),
					),
				).toEqual(["flagged"]);
			});

			test("a batch writes every operation or none, refused with the status of the one that failed", async () => {
				const pk = partition();
				const x = await docs.create<Doc>({ id: "x", pk, v: 1 });
				await docs.batch(pk, [
					{
						type: "patch",
						id: "x",
						operations: [{ op: "set", path: "/v", value: 2 }],
						ifMatch: x._etag,
					},
					{ type: "create", document: { id: "y", pk } },
				]);
				expect(await docs.read<Doc>("x", pk)).toMatchObject({ v: 2 });
				expect(await docs.read("y", pk)).not.toBeNull();

				const setV3 = {
					type: "patch" as const,
					id: "x",
					operations: [{ op: "set" as const, path: "/v", value: 3 }],
				};
				await expect(
					docs.batch(pk, [
						setV3,
						{ type: "create", document: { id: "y", pk } },
					]),
				).rejects.toEqual(refusedWith(409));
				await expect(
					docs.batch(pk, [
						{ ...setV3, ifMatch: x._etag },
						{ type: "create", document: { id: "z", pk } },
					]),
				).rejects.toEqual(refusedWith(412));
				await expect(
					docs.batch(pk, [
						{ type: "create", document: { id: "z", pk } },
						{ ...setV3, id: "missing" },
					]),
				).rejects.toEqual(refusedWith(404));
				expect(await docs.read<Doc>("x", pk)).toMatchObject({ v: 2 });
				expect(await docs.read("z", pk)).toBeNull();
			});

			test("verify finds each declared container with its partition key, and refuses one missing or partitioned otherwise", async () => {
				await cosmos.database.verify([DOCS]);
				await expect(
					cosmos.database.verify([{ name: "absent", partitionKey: "/pk" }]),
				).rejects.toEqual(refusedWith(404));
				await expect(
					cosmos.database.verify([{ name: DOCS.name, partitionKey: "/id" }]),
				).rejects.toThrow(/partitioned by \/pk, not \/id/);
			});

			test("verify refuses a container declared to keep its documents' lifetimes that keeps none, and passes one that does", async () => {
				await expect(
					cosmos.database.verify([{ ...DOCS, itemTtl: true }]),
				).rejects.toThrow(/keeps no lifetime for its documents/);
				const timed = await openTestCosmos(
					[{ name: "timed", partitionKey: "/pk", itemTtl: true }],
					emulator,
				);
				try {
					await timed.database.verify([
						{ name: "timed", partitionKey: "/pk", itemTtl: true },
					]);
					// Not asked for, it is not looked at.
					await timed.database.verify([{ name: "timed", partitionKey: "/pk" }]);
				} finally {
					await timed.drop();
				}
			});
		},
	);
}
