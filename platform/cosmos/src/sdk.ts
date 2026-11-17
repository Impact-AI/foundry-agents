import type {
	Container,
	Database,
	JSONObject,
	OperationInput,
	OperationResponse,
	PatchRequestBody,
	RequestOptions,
} from "@azure/cosmos";
import {
	type BatchOperation,
	type CosmosDatabase,
	type CosmosDocument,
	CosmosStatusError,
	type DocumentContainer,
	type PatchSet,
	type QuerySpec,
	type Stored,
	type WriteConditions,
} from "./container";

/**
 * The container surface over `@azure/cosmos`. The SDK answers a refusal
 * three ways — a thrown error carrying `code`, a read response carrying
 * `statusCode`, a batch whose results carry one each — and the stores should
 * meet one: here every refusal becomes a {@link CosmosStatusError}, and a
 * missing document a null.
 */

/** The HTTP status of an SDK error, when it has one; a network failure has a string code or none. */
function statusOf(err: unknown): number | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "number" ? code : undefined;
}

/** The SDK's error as this package's, by status; anything without one is thrown as it came. */
function refusal(err: unknown): never {
	const status = statusOf(err);
	if (status === undefined) throw err;
	throw new CosmosStatusError(status, (err as Error).message, { cause: err });
}

function conditionsOf({ ifMatch }: WriteConditions): RequestOptions {
	return ifMatch
		? { accessCondition: { type: "IfMatch", condition: ifMatch } }
		: {};
}

/**
 * A patch's body, in the one shape every surface accepts: the object with
 * `operations`. The SDK's type admits a bare array too, and `item().patch`
 * takes one, but a transactional batch does not — the service refuses it
 * with 400 "Field 'resourceBody' has unexpected value type", which the
 * in-memory stand-in could never show.
 */
function patchBody(
	operations: readonly PatchSet[],
	condition?: string,
): PatchRequestBody {
	const ops = operations.map(({ op, path, value }) => ({ op, path, value }));
	return condition ? { operations: ops, condition } : { operations: ops };
}

/** The SDK's input for one operation of a batch; exported so a test can see the wire shape. */
export function operationInput(operation: BatchOperation): OperationInput {
	if (operation.type === "create")
		return {
			operationType: "Create",
			resourceBody: operation.document as JSONObject,
		};
	return {
		operationType: "Patch",
		id: operation.id,
		resourceBody: patchBody(operation.operations, operation.condition),
		...(operation.ifMatch ? { ifMatch: operation.ifMatch } : {}),
	};
}

/**
 * The status a failed batch is refused with: the operation that failed, not
 * the 424s the service gives the operations that were rolled back because of
 * it. Null when every operation succeeded.
 */
export function batchFailure(
	results: readonly Pick<OperationResponse, "statusCode">[],
): number | null {
	const failed = results.filter((r) => r.statusCode >= 400);
	if (failed.length === 0) return null;
	return (
		(failed.find((r) => r.statusCode !== 424) ?? failed[0])?.statusCode ?? null
	);
}

function documentContainer(container: Container): DocumentContainer {
	return {
		async read<T extends CosmosDocument>(id: string, partitionKey: string) {
			try {
				const { resource, statusCode } = await container
					.item(id, partitionKey)
					.read<Stored<T>>();
				return statusCode === 404 ? null : (resource ?? null);
			} catch (err) {
				return refusal(err);
			}
		},

		async create<T extends CosmosDocument>(document: T) {
			try {
				const { resource } = await container.items.create<T>(document);
				return resource as Stored<T>;
			} catch (err) {
				return refusal(err);
			}
		},

		async patch<T extends CosmosDocument>(
			id: string,
			partitionKey: string,
			operations: readonly PatchSet[],
			conditions: WriteConditions = {},
		) {
			try {
				const { resource } = await container
					.item(id, partitionKey)
					.patch<Stored<T>>(
						patchBody(operations, conditions.condition),
						conditionsOf(conditions),
					);
				return resource ?? null;
			} catch (err) {
				if (statusOf(err) === 404) return null;
				return refusal(err);
			}
		},

		async delete(id: string, partitionKey: string) {
			try {
				await container.item(id, partitionKey).delete();
				return true;
			} catch (err) {
				if (statusOf(err) === 404) return false;
				return refusal(err);
			}
		},

		async query<T extends CosmosDocument>(
			spec: QuerySpec,
			partitionKey: string,
		) {
			try {
				const { resources } = await container.items
					.query<Stored<T>>(spec, { partitionKey })
					.fetchAll();
				return resources;
			} catch (err) {
				return refusal(err);
			}
		},

		async batch(partitionKey: string, operations: readonly BatchOperation[]) {
			let results: OperationResponse[];
			try {
				({ result: results = [] } = await container.items.batch(
					operations.map(operationInput),
					partitionKey,
				));
			} catch (err) {
				// The SDK wraps the service's refusal of the whole batch.
				return refusal((err as Error).cause ?? err);
			}
			const failed = batchFailure(results);
			if (failed !== null)
				throw new CosmosStatusError(
					failed,
					`the batch was refused with ${failed}; nothing was written`,
				);
		},
	};
}

/** The database `database` names, as the container surface. */
export function sdkDatabase(database: Database): CosmosDatabase {
	return {
		container: (name) => documentContainer(database.container(name)),
		async verify(definitions) {
			try {
				await database.read();
				for (const { name, partitionKey, itemTtl } of definitions) {
					const { resource } = await database.container(name).read();
					const paths = resource?.partitionKey?.paths ?? [];
					if (paths.length !== 1 || paths[0] !== partitionKey)
						throw new Error(
							`the container "${name}" is partitioned by ${paths.join(", ") || "nothing"}, not ${partitionKey}`,
						);
					// With no lifetime of its own a container ignores a document's: what was written to remove itself would stay for good.
					if (itemTtl && typeof resource?.defaultTtl !== "number")
						throw new Error(
							`the container "${name}" keeps no lifetime for its documents (its default time to live is off), so a document written to remove itself never would: set it to -1, which the template does on a provision`,
						);
				}
			} catch (err) {
				refusal(err);
			}
		},
	};
}
