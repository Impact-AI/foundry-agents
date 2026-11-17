import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { setBlobService } from "../service";

/**
 * A stand-in at the SDK boundary, and nowhere else: one container that
 * records what was written, listed and deleted, reads back what was
 * written, and keeps what the service keeps beside the bytes — the type,
 * the MD5 it computes on a single-shot upload, and the metadata, its keys
 * lower-cased as they come back over HTTP.
 */

export interface StoredBlob {
	bytes: Uint8Array;
	contentType?: string;
	contentMD5?: Uint8Array;
	metadata: Record<string, string>;
}

export interface FakeBlob {
	objects: Map<string, StoredBlob>;
	/** Keys, in the order deleted. */
	deleted: string[];
	/** The container each operation opened, in order: the one the fake serves stands for any of them. */
	containers: string[];
	/** Whether a download says how long it is; a store is not bound to. */
	declaresLength: boolean;
	/** Store `bytes` under `key` as an upload would, MD5 and all. */
	put(
		key: string,
		bytes: Uint8Array | string,
		description?: { contentType?: string; metadata?: Record<string, string> },
	): void;
}

function notFound(): Error {
	return Object.assign(new Error("BlobNotFound"), { statusCode: 404 });
}

const md5 = (bytes: Uint8Array) =>
	new Uint8Array(createHash("md5").update(bytes).digest());

function lowerKeys(metadata: Record<string, string> = {}) {
	return Object.fromEntries(
		Object.entries(metadata).map(([k, v]) => [k.toLowerCase(), v]),
	);
}

type UploadOptions = {
	blobHTTPHeaders?: { blobContentType?: string };
	metadata?: Record<string, string>;
};

/** A fake service registered as the process's, serving one recording container. */
export function fakeBlob(): FakeBlob {
	const fake: FakeBlob = {
		objects: new Map(),
		deleted: [],
		containers: [],
		declaresLength: true,
		put(key, bytes, description = {}) {
			const data =
				typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
			fake.objects.set(key, {
				bytes: data,
				contentType: description.contentType,
				contentMD5: md5(data),
				metadata: lowerKeys(description.metadata),
			});
		},
	};
	const held = (key: string) => {
		const object = fake.objects.get(key);
		if (!object) throw notFound();
		return object;
	};
	const container = {
		getBlockBlobClient(key: string) {
			return {
				async uploadData(data: Uint8Array, options?: UploadOptions) {
					fake.put(key, new Uint8Array(data), {
						contentType: options?.blobHTTPHeaders?.blobContentType,
						metadata: options?.metadata,
					});
				},
				async getProperties() {
					const object = held(key);
					return {
						contentType: object.contentType,
						contentMD5: object.contentMD5,
						...(fake.declaresLength
							? { contentLength: object.bytes.byteLength }
							: {}),
						metadata: { ...object.metadata },
					};
				},
				async setMetadata(metadata: Record<string, string>) {
					held(key).metadata = lowerKeys(metadata);
				},
				async setHTTPHeaders(headers: {
					blobContentType?: string;
					blobContentMD5?: Uint8Array;
				}) {
					const object = held(key);
					object.contentType = headers.blobContentType;
					object.contentMD5 = headers.blobContentMD5;
				},
				async download() {
					const object = held(key);
					return {
						readableStreamBody: Readable.from([Buffer.from(object.bytes)]),
						contentType: object.contentType,
						contentLength: object.bytes.byteLength,
						metadata: { ...object.metadata },
					};
				},
				async deleteIfExists() {
					fake.deleted.push(key);
					return { succeeded: fake.objects.delete(key) };
				},
			};
		},
		// A listing carries metadata only when asked, as the service's does.
		async *listBlobsFlat({
			prefix,
			includeMetadata,
		}: {
			prefix: string;
			includeMetadata?: boolean;
		}) {
			for (const [name, object] of [...fake.objects.entries()].sort(
				([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
			))
				if (name.startsWith(prefix))
					yield {
						name,
						properties: {
							contentType: object.contentType,
							contentMD5: object.contentMD5,
						},
						...(includeMetadata ? { metadata: { ...object.metadata } } : {}),
					};
		},
	} as unknown as ContainerClient;
	setBlobService({
		getContainerClient: (name: string) => {
			fake.containers.push(name);
			return container;
		},
	} as unknown as BlobServiceClient);
	return fake;
}
