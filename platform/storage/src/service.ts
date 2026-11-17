import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import {
	azureCredential,
	processSingleton,
	resetSingleton,
	setSingleton,
} from "@platform/config";
import { requireBlobStore } from "./store";

/**
 * The one client for the deployment's store, keyless: the process's identity holds
 * Storage Blob Data Contributor on the account, so the account key stays
 * disabled and nothing here holds a secret.
 */

const SERVICE = "storage:blob-service";

function blobService(): BlobServiceClient {
	return processSingleton(
		SERVICE,
		() => new BlobServiceClient(requireBlobStore().base, azureCredential()),
	);
}

/** The store's container, or another on the same account when one is named. */
export function blobContainer(name?: string): ContainerClient {
	return blobService().getContainerClient(name ?? requireBlobStore().container);
}

/** Use `client` instead of the real service. For tests. */
export function setBlobService(client: BlobServiceClient): void {
	setSingleton(SERVICE, client);
}

export function resetBlobService(): void {
	resetSingleton(SERVICE);
}
