import { envString } from "@platform/config";

/**
 * The process's own object store, as the environment describes it.
 *
 * `AZURE_STORAGE_ACCOUNT` names the account and gives its blob origin;
 * `AZURE_STORAGE_ENDPOINT` overrides that origin, which is how a local
 * emulator (whose endpoint carries the account in its path) stands in for it.
 * `AZURE_STORAGE_CONTAINER` is the one container read and written, `library`
 * by default. With neither account nor endpoint set, there is no store:
 * nothing is there to read. An endpoint that is set and is not a URL is a
 * mistake in the configuration and is said as one: answered as "no store",
 * every listing would be empty and a load would report an empty library.
 */
export interface BlobStore {
	/** Origin plus any path the endpoint carries, without a trailing slash. */
	base: string;
	container: string;
}

const DEFAULT_CONTAINER = "library";

export function blobStore(): BlobStore | undefined {
	const account = envString("AZURE_STORAGE_ACCOUNT");
	const endpoint =
		envString("AZURE_STORAGE_ENDPOINT") ??
		(account ? `https://${account}.blob.core.windows.net` : undefined);
	if (!endpoint) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		throw new Error(
			`The object store's endpoint is not a URL: ${endpoint} (AZURE_STORAGE_ENDPOINT, or the origin made from AZURE_STORAGE_ACCOUNT).`,
		);
	}
	return {
		base: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`,
		container: envString("AZURE_STORAGE_CONTAINER") ?? DEFAULT_CONTAINER,
	};
}

/** The store, for a caller that cannot do without one. */
export function requireBlobStore(): BlobStore {
	const store = blobStore();
	if (!store)
		throw new Error(
			"No object store is configured: set AZURE_STORAGE_ACCOUNT or AZURE_STORAGE_ENDPOINT.",
		);
	return store;
}
