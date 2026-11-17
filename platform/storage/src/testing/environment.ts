import { scopedEnv } from "@platform/test-support";

export interface StoreEnv {
	account?: string;
	endpoint?: string;
	container?: string;
}

/** The store's three variables scoped to a test; a missing field unsets its variable. */
export function storeEnv({
	account,
	endpoint,
	container,
}: StoreEnv): () => void {
	return scopedEnv({
		AZURE_STORAGE_ACCOUNT: account,
		AZURE_STORAGE_ENDPOINT: endpoint,
		AZURE_STORAGE_CONTAINER: container,
	});
}
