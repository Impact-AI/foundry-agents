import { Readable } from "node:stream";
import { isNotFound } from "@platform/config";
import { blobContainer } from "./service";
import { blobStore } from "./store";

/**
 * The store's one container, blob by blob: listed with metadata, read as a
 * stream, written whole with its type and metadata, re-described, deleted.
 * Every read and write is the process's identity; nothing here signs a URL,
 * so a blob reaches a client only as bytes this process read and streamed.
 *
 * Metadata keys come back lower-cased (they travel as HTTP headers), so a
 * caller names them in lower case.
 */

export interface BlobEntry {
	name: string;
	contentType?: string;
	/** The MD5 the service holds, which it computes itself for a single-shot upload. */
	contentMD5?: Uint8Array;
	metadata: Record<string, string>;
}

export interface StoredObject {
	body: ReadableStream<Uint8Array>;
	contentType?: string;
	contentLength?: number;
	/** What the blob says of itself, from the answer that carries its bytes: the two are one version of it. */
	metadata: Record<string, string>;
}

/** Every blob under `prefix`, with its type, its MD5 and its metadata. Nothing when there is no store. */
export async function* listBlobs(prefix: string): AsyncGenerator<BlobEntry> {
	if (!blobStore()) return;
	for await (const blob of blobContainer().listBlobsFlat({
		prefix,
		includeMetadata: true,
	}))
		yield {
			name: blob.name,
			contentType: blob.properties.contentType,
			contentMD5: blob.properties.contentMD5,
			metadata: blob.metadata ?? {},
		};
}

/** One blob's description, or null when it is absent or there is no store. */
export async function blobProperties(name: string): Promise<BlobEntry | null> {
	if (!blobStore()) return null;
	try {
		const props = await blobContainer()
			.getBlockBlobClient(name)
			.getProperties();
		return {
			name,
			contentType: props.contentType,
			contentMD5: props.contentMD5,
			metadata: props.metadata ?? {},
		};
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}

/**
 * One blob, streamed. Null when there is no such blob, or no store to hold
 * one; any other failure throws. `container` reads from another container on
 * the same account rather than the store's own.
 */
export async function readBlob(
	name: string,
	container?: string,
): Promise<StoredObject | null> {
	if (!blobStore()) return null;
	try {
		const download = await blobContainer(container)
			.getBlockBlobClient(name)
			.download();
		if (!download.readableStreamBody) return null;
		return {
			body: Readable.toWeb(
				download.readableStreamBody as Readable,
			) as ReadableStream<Uint8Array>,
			contentType: download.contentType,
			contentLength: download.contentLength,
			metadata: download.metadata ?? {},
		};
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}

export interface BlobDescription {
	contentType?: string;
	metadata?: Record<string, string>;
}

/** Write a blob whole, replacing what was there, type and metadata included. */
export async function putBlob(
	name: string,
	bytes: Uint8Array,
	description: BlobDescription = {},
): Promise<void> {
	await blobContainer()
		.getBlockBlobClient(name)
		.uploadData(bytes, {
			blobHTTPHeaders: description.contentType
				? { blobContentType: description.contentType }
				: undefined,
			metadata: description.metadata,
		});
}

/**
 * Re-describe a blob in place: its metadata replaced, and its type when one
 * is given. Setting the type rewrites every HTTP header, so the MD5 the
 * blob had is carried over rather than cleared.
 */
export async function describeBlob(
	entry: Pick<BlobEntry, "name" | "contentMD5">,
	description: BlobDescription,
): Promise<void> {
	const blob = blobContainer().getBlockBlobClient(entry.name);
	if (description.contentType)
		await blob.setHTTPHeaders({
			blobContentType: description.contentType,
			blobContentMD5: entry.contentMD5,
		});
	if (description.metadata) await blob.setMetadata(description.metadata);
}

/** Delete a blob and its snapshots; an absent one is already gone. */
export async function deleteBlob(name: string): Promise<void> {
	await blobContainer()
		.getBlockBlobClient(name)
		.deleteIfExists({ deleteSnapshots: "include" });
}
