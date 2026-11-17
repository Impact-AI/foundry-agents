import type { SearchIndex } from "@azure/search-documents";
import { isConflict, isNotFound } from "@platform/config";
import { knowledgeSettings } from "../config/knowledge";
import { searchIndexClient, searchIndexerClient } from "../index/client";
import { chunkIndexDefinition, FIELD } from "../index/definition";
import {
	knowledgeBaseDefinition,
	knowledgeSourceDefinition,
	retiredKnowledgeBaseNames,
} from "../knowledge-base/definition";
import {
	dataSourceDefinition,
	indexerDefinition,
	pipelineNames,
	skillsetDefinition,
} from "./definitions";

/**
 * The job's `index` step: the index, the data source, the skillset and the
 * indexer, made or brought up to date, in the order each names the last.
 *
 * An index keyed on another field, or whose vector field is not stored, is
 * one this definition cannot update in place — the service refuses to change
 * a key, and a field's `stored` is set once — and it is a projection of the
 * library, nothing more, so it is deleted and made again, and the indexer
 * reset so its next run reads every blob rather than only those changed since
 * a run that filled the index just deleted. The knowledge base and source
 * over the index are deleted first, since the service will not delete an
 * index a source names. That run is the caller's: the
 * job's `index` step refills a rebuilt index at once (`refillIndex`).
 */
export async function ensurePipeline(): Promise<{
	names: ReturnType<typeof pipelineNames>;
	rebuilt: boolean;
}> {
	const names = pipelineNames();
	const indexes = searchIndexClient();
	const indexers = searchIndexerClient();
	const { indexer: settings } = await knowledgeSettings();

	const rebuilt = await dropIncompatibleIndex(names.index);
	// After a rebuild the index was just deleted, so a conflict on its PUT can
	// only be the lost-response retry below: the first PUT made it.
	await applied(indexes.createOrUpdateIndex(await chunkIndexDefinition()));
	await applied(
		indexers.createOrUpdateDataSourceConnection(dataSourceDefinition()),
	);
	await applied(
		indexers.createOrUpdateSkillset(await skillsetDefinition(settings)),
	);
	await applied(indexers.createOrUpdateIndexer(indexerDefinition(settings)));
	if (rebuilt) await indexers.resetIndexer(names.indexer);
	return { names, rebuilt };
}

/**
 * A 409 on one of these unconditional PUTs is the write already applied: the
 * HTTP pipeline retries a PUT whose response was lost, and the service refuses
 * the retry as a conflicting update of the first. Anything else is the error
 * it says it is. The knowledge base's writes, unconditional PUTs too, read
 * their 409s the same way.
 */
export async function applied(write: Promise<unknown>): Promise<void> {
	try {
		await write;
	} catch (err) {
		if (!isConflict(err)) throw err;
	}
}

async function dropIncompatibleIndex(name: string): Promise<boolean> {
	const indexes = searchIndexClient();
	let fields: SearchIndex["fields"];
	try {
		fields = (await indexes.getIndex(name)).fields;
	} catch (err) {
		if (isNotFound(err)) return false;
		throw err;
	}
	const key = fields.find((f) => "key" in f && f.key)?.name;
	const vector = fields.find((f) => f.name === FIELD.vector);
	// The shield's merge erases a vector the index does not store.
	const unstored = !!vector && "stored" in vector && vector.stored === false;
	if (key === FIELD.key && !unstored) return false;
	console.warn(
		key === FIELD.key
			? `[index] "${name}" does not store "${FIELD.vector}", so every merge erases a chunk's vector: deleting it, to be made again and filled by the indexer`
			: `[index] "${name}" is keyed on "${key}", not "${FIELD.key}": deleting it, to be made again and filled by the indexer`,
	);
	await releaseKnowledgeSource();
	await indexes.deleteIndex(name);
	return true;
}

/**
 * The service refuses to delete an index a knowledge source names, and a
 * source a knowledge base names, so the template's bases and its source go
 * first; the same step's `ensureKnowledgeBase` makes them again over the new
 * index when the knowledge base is the engine. The SDK's deletes answer one
 * already gone as done.
 */
async function releaseKnowledgeSource(): Promise<void> {
	const indexes = searchIndexClient();
	for (const base of [
		knowledgeBaseDefinition().name,
		...retiredKnowledgeBaseNames(),
	])
		await indexes.deleteKnowledgeBase(base);
	await indexes.deleteKnowledgeSource(knowledgeSourceDefinition().name);
}
