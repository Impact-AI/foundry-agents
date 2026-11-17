/**
 * The container surface every store is written against: the handful of
 * Cosmos DB operations the app's records need, each with the semantics the
 * service gives it, and nothing else. Two things implement it — the SDK
 * adapter (`./sdk`) and the in-memory stand-in (`./testing`) — and one shared
 * suite (`testing/contract.ts`) holds them to the same answers, run against the
 * emulator in CI, so the stand-in a test runs on cannot drift from the
 * service a deployment runs on.
 *
 * Every read and write names its partition key: a query never fans out
 * across partitions, and the type says so.
 */

/** A document as it is written: an id, unique within its partition, and the fields. */
export interface CosmosDocument {
	id: string;
	[field: string]: unknown;
}

/** A document as the service answers it: with the etag a conditional write names. */
export type Stored<T extends CosmosDocument> = T & { _etag: string };

/** Set one field, made if absent. The only patch operation the stores need. */
export interface PatchSet {
	op: "set";
	/** A JSON pointer, `/name`. Never the id or the partition key. */
	path: string;
	value: unknown;
}

/** The service refuses a patch of more operations than this. */
export const PATCH_MAX_OPERATIONS = 10;

/** The service refuses a transactional batch of more operations than this. */
export const BATCH_MAX_OPERATIONS = 100;

/** The service refuses a transactional batch whose payload is larger than this, and a document larger than this. */
export const BATCH_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What a write is conditional on. `ifMatch` is the etag the document must
 * still carry; `condition` is a predicate, `FROM c WHERE …`, the document
 * must satisfy. Either failing is 412 and nothing is written.
 */
export interface WriteConditions {
	ifMatch?: string;
	condition?: string;
}

/** One operation of a transactional batch, every one in the batch's partition. */
export type BatchOperation =
	| { type: "create"; document: CosmosDocument }
	| ({ type: "patch"; id: string; operations: PatchSet[] } & WriteConditions);

/** A query and its `@name` parameters: values never spliced into the text. */
export interface QuerySpec {
	query: string;
	parameters?: { name: string; value: string | number | boolean | null }[];
}

export interface DocumentContainer {
	/** The document, or null when the partition holds no document by that id. */
	read<T extends CosmosDocument>(
		id: string,
		partitionKey: string,
	): Promise<Stored<T> | null>;
	/** Write a new document. Throws 409 when its partition holds that id already. */
	create<T extends CosmosDocument>(document: T): Promise<Stored<T>>;
	/**
	 * Apply the operations atomically and answer the document as it now is;
	 * null when there is no such document. Throws 412 when a condition fails.
	 */
	patch<T extends CosmosDocument>(
		id: string,
		partitionKey: string,
		operations: readonly PatchSet[],
		conditions?: WriteConditions,
	): Promise<Stored<T> | null>;
	/** True when a document went, false when there was none. */
	delete(id: string, partitionKey: string): Promise<boolean>;
	/** Every match in one partition, in the query's order, however many pages the service answers in. */
	query<T extends CosmosDocument>(
		spec: QuerySpec,
		partitionKey: string,
	): Promise<Stored<T>[]>;
	/**
	 * All of the operations or none of them, in one partition. Throws with the
	 * status of the operation that failed (409, 412, 404), and then nothing
	 * was written.
	 */
	batch(
		partitionKey: string,
		operations: readonly BatchOperation[],
	): Promise<void>;
}

/** A container as a package declares it: what the template creates, and what a test or the emulator is given. */
export interface ContainerDefinition {
	name: string;
	/** The partition key path, `/id`; one level, as every container here is. */
	partitionKey: `/${string}`;
	/** Composite indexes an `ORDER BY` over several fields needs. */
	compositeIndexes?: {
		path: `/${string}`;
		order: "ascending" | "descending";
	}[][];
	/**
	 * Whether a document may carry its own lifetime: a `ttl` in seconds,
	 * counted from its last write, after which the service removes it (`-1`
	 * on a document is never). The container is made with no lifetime of its
	 * own, so a document without the field is kept.
	 */
	itemTtl?: boolean;
}

export interface CosmosDatabase {
	container(name: string): DocumentContainer;
	/**
	 * Read the database and each declared container: what proves this
	 * identity may reach them, and that every container exists with the
	 * partition key its store addresses it by — a point read in the wrong
	 * partition answers nothing, never an error — and, for a container
	 * declared with `itemTtl`, that it keeps a lifetime for its documents at
	 * all: one that does not ignores a document's own, silently. Throws as
	 * every operation does, and plainly on a partition key that differs or a
	 * lifetime that is off.
	 */
	verify(definitions: readonly ContainerDefinition[]): Promise<void>;
}

/** A refusal from the service, by its HTTP status, whichever implementation answered. */
export class CosmosStatusError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CosmosStatusError";
	}
}

/** Whether `err` is the service refusing with `status`. */
export function hasStatus(err: unknown, status: number): boolean {
	return err instanceof CosmosStatusError && err.statusCode === status;
}
