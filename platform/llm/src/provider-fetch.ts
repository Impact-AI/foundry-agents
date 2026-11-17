/**
 * The one fetch every provider request goes through, whichever client
 * assembles it: the AI SDK's provider here, the OpenAI client a sibling
 * package dials the same account with. It is the boundary a test stands the
 * provider in at, so that everything above it — the token, the bounds, the
 * usage line, the request as the client assembles it — runs for real.
 */
import {
	processSingleton,
	resetSingleton,
	setSingleton,
} from "@platform/config";

const FETCH = "llm:provider-fetch";

/**
 * A client's `fetch` is typed as the whole global, statics included, but it
 * only ever calls it; a stand-in needs just the call.
 */
export type ProviderFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/** The stand-in a test installed, else the runtime's. */
export function providerFetch(): ProviderFetch {
	return (
		processSingleton<ProviderFetch | undefined>(FETCH, () => undefined) ?? fetch
	);
}

/** Route every provider request through `fetch` instead of the network. For tests. */
export function setProviderFetch(fetch: ProviderFetch): void {
	setSingleton(FETCH, fetch);
}

export function resetProviderFetch(): void {
	resetSingleton(FETCH);
}
