import {
	BATCH_MAX_BYTES,
	BATCH_MAX_OPERATIONS,
	type BatchOperation,
	type ContainerDefinition,
	type CosmosDatabase,
	type CosmosDocument,
	CosmosStatusError,
	type DocumentContainer,
	PATCH_MAX_OPERATIONS,
	type PatchSet,
	type QuerySpec,
	type Stored,
	type WriteConditions,
} from "../container";
import { evaluate, parseCondition, parseQuery, runQuery } from "./sql";

/**
 * The container surface in memory, for the suites that run where no
 * emulator does. It refuses what the service refuses, with the service's
 * status: a second document with an id its partition holds (409), a write
 * whose etag or condition no longer holds (412), a patch of the id or the
 * partition key, or of more than ten operations (400); it scopes every read,
 * query and batch to one partition; and a batch is applied to a copy that
 * replaces the original only when every operation succeeded. What a caller
 * is handed is a copy, so a caller cannot change what is stored by changing
 * what it read. `testing/contract.ts` holds the conflict, the precondition,
 * the partition scoping, the query order and the batch to the emulator's
 * answers; the 400 refusals and the copies are this stand-in's word alone.
 *
 * It keeps no index: a container's `compositeIndexes` are not read, so an
 * `ORDER BY` over several fields that the service would refuse for want of
 * a composite index is answered here. Such a query is only proven by the
 * suite's run on the emulator.
 *
 * A container declared with `itemTtl` honours a document's own `ttl`: a
 * document whose last write is `ttl` seconds old is absent from every read,
 * query and write, as one the service has removed is. The clock is the
 * caller's to name, so a test reaches the end of a lifetime without waiting
 * for it; this too is the stand-in's word alone. A `ttl` that is not a
 * positive whole number or -1 is refused (400) on any write, as the service
 * documents it.
 */

type Documents = Map<string, Stored<CosmosDocument>>;

const slot = (partitionKey: string, id: string) =>
	JSON.stringify([partitionKey, id]);

function refuse(status: number, message: string): never {
	throw new CosmosStatusError(status, message);
}

/** Milliseconds since the epoch, as `Date.now` answers. */
type Clock = () => number;

/**
 * A fresh etag and timestamp, as the service stamps every write. A `ttl` the
 * document carries is a whole number of seconds above zero, or -1 for never:
 * the service refuses anything else, whichever container it is written to.
 */
function stamped<T extends CosmosDocument>(document: T, now: Clock): Stored<T> {
	const { ttl } = document as { ttl?: unknown };
	if (
		ttl !== undefined &&
		!(
			typeof ttl === "number" &&
			Number.isInteger(ttl) &&
			(ttl > 0 || ttl === -1)
		)
	)
		refuse(
			400,
			"a document's ttl is a positive whole number of seconds, or -1",
		);
	return {
		...structuredClone(document),
		_etag: `"${crypto.randomUUID()}"`,
		_ts: Math.floor(now() / 1000),
	};
}

const ID_REFUSED = /[/\\?#]/;

class FakeContainer implements DocumentContainer {
	private documents: Documents = new Map();
	private readonly field: string;
	private readonly itemTtl: boolean;

	constructor(
		definition: ContainerDefinition,
		private readonly now: Clock,
	) {
		this.field = definition.partitionKey.slice(1);
		this.itemTtl = definition.itemTtl === true;
	}

	/** Drop every document whose own lifetime has run out, before anything reads or writes. */
	private expire(): void {
		if (!this.itemTtl) return;
		const seconds = Math.floor(this.now() / 1000);
		for (const [key, document] of this.documents) {
			const { ttl, _ts } = document as { ttl?: unknown; _ts?: unknown };
			if (
				typeof ttl === "number" &&
				ttl > 0 &&
				typeof _ts === "number" &&
				_ts + ttl <= seconds
			)
				this.documents.delete(key);
		}
	}

	private partitionOf(document: CosmosDocument): string {
		const value = document[this.field];
		if (typeof value !== "string")
			refuse(400, `the document carries no partition key /${this.field}`);
		return value;
	}

	private createIn<T extends CosmosDocument>(
		documents: Documents,
		document: T,
	): Stored<T> {
		if (
			typeof document.id !== "string" ||
			!document.id ||
			ID_REFUSED.test(document.id)
		)
			refuse(400, `"${document.id}" is not an id the service accepts`);
		const key = slot(this.partitionOf(document), document.id);
		if (documents.has(key))
			refuse(409, `"${document.id}" exists in its partition`);
		const written = stamped(document, this.now);
		documents.set(key, written);
		return structuredClone(written);
	}

	private patchIn<T extends CosmosDocument>(
		documents: Documents,
		id: string,
		partitionKey: string,
		operations: readonly PatchSet[],
		{ ifMatch, condition }: WriteConditions,
	): Stored<T> | null {
		if (operations.length === 0 || operations.length > PATCH_MAX_OPERATIONS)
			refuse(400, `a patch carries 1 to ${PATCH_MAX_OPERATIONS} operations`);
		const key = slot(partitionKey, id);
		const current = documents.get(key);
		if (!current) return null;
		if (ifMatch && ifMatch !== current._etag)
			refuse(412, "the etag no longer matches");
		if (condition) {
			const { alias, where } = parseCondition(condition);
			if (evaluate(where, alias, current, new Map()) !== true)
				refuse(412, "the condition does not hold");
		}
		const next = structuredClone(current) as Record<string, unknown>;
		for (const { op, path, value } of operations) {
			const segments = path.split("/").slice(1);
			const last = segments.pop();
			if (op !== "set" || !last || path === "/id" || path === `/${this.field}`)
				refuse(400, `the stand-in does not ${op} ${path}`);
			let parent: unknown = next;
			for (const segment of segments)
				parent = (parent as Record<string, unknown> | undefined)?.[segment];
			if (
				parent === null ||
				typeof parent !== "object" ||
				Array.isArray(parent)
			)
				refuse(400, `${path} has no object to be set in`);
			(parent as Record<string, unknown>)[last] = structuredClone(value);
		}
		const written = stamped(next as CosmosDocument, this.now);
		documents.set(key, written);
		return structuredClone(written) as Stored<T>;
	}

	async read<T extends CosmosDocument>(id: string, partitionKey: string) {
		this.expire();
		const found = this.documents.get(slot(partitionKey, id));
		return found ? (structuredClone(found) as Stored<T>) : null;
	}

	async create<T extends CosmosDocument>(document: T) {
		this.expire();
		return this.createIn(this.documents, document);
	}

	async patch<T extends CosmosDocument>(
		id: string,
		partitionKey: string,
		operations: readonly PatchSet[],
		conditions: WriteConditions = {},
	) {
		this.expire();
		return this.patchIn<T>(
			this.documents,
			id,
			partitionKey,
			operations,
			conditions,
		);
	}

	async delete(id: string, partitionKey: string) {
		this.expire();
		return this.documents.delete(slot(partitionKey, id));
	}

	async query<T extends CosmosDocument>(spec: QuerySpec, partitionKey: string) {
		this.expire();
		const parameters = new Map(
			(spec.parameters ?? []).map(({ name, value }) => [name, value]),
		);
		const inPartition = [...this.documents.values()].filter(
			(d) => d[this.field] === partitionKey,
		);
		return runQuery(parseQuery(spec.query), inPartition, parameters).map(
			(d) => structuredClone(d) as Stored<T>,
		);
	}

	async batch(partitionKey: string, operations: readonly BatchOperation[]) {
		this.expire();
		if (operations.length === 0 || operations.length > BATCH_MAX_OPERATIONS)
			refuse(400, `a batch carries 1 to ${BATCH_MAX_OPERATIONS} operations`);
		if (Buffer.byteLength(JSON.stringify(operations)) > BATCH_MAX_BYTES)
			refuse(413, `a batch's payload is at most ${BATCH_MAX_BYTES} bytes`);
		const staged: Documents = new Map(this.documents);
		for (const operation of operations) {
			if (operation.type === "create") {
				if (this.partitionOf(operation.document) !== partitionKey)
					refuse(400, "a batch writes to one partition");
				this.createIn(staged, operation.document);
			} else if (
				!this.patchIn(
					staged,
					operation.id,
					partitionKey,
					operation.operations,
					operation,
				)
			)
				refuse(404, `"${operation.id}" is not in the partition`);
		}
		this.documents = staged;
	}
}

/** An empty database holding the containers `definitions` declare, on the clock named: the system's by default. */
export function fakeCosmosDatabase(
	definitions: readonly ContainerDefinition[],
	now: Clock = Date.now,
): CosmosDatabase {
	const containers = new Map(
		definitions.map((d) => [d.name, new FakeContainer(d, now)]),
	);
	return {
		container(name) {
			const found = containers.get(name);
			if (!found) refuse(404, `the database has no container "${name}"`);
			return found;
		},
		async verify(declared) {
			for (const { name, partitionKey, itemTtl } of declared) {
				const held = definitions.find((d) => d.name === name);
				if (!held) refuse(404, `the database has no container "${name}"`);
				if (held.partitionKey !== partitionKey)
					throw new Error(
						`the container "${name}" is partitioned by ${held.partitionKey}, not ${partitionKey}`,
					);
				if (itemTtl && !held.itemTtl)
					throw new Error(
						`the container "${name}" keeps no lifetime for its documents (its default time to live is off), so a document written to remove itself never would: set it to -1, which the template does on a provision`,
					);
			}
		},
	};
}
