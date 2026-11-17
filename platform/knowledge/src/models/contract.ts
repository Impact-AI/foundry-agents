import type { ZodType } from "zod";

/**
 * The one model call this package makes, as an interface the app wires: the
 * query planner's draft. Nothing here names a provider; ./azure is the
 * default implementation and ./registry is where a process's wiring lives.
 * Embedding is Azure AI Search's own, through the index's vectorizer and the
 * indexer's skillset, so no embedding call is made from here.
 */

export interface DraftRequest<T> {
	system: string;
	prompt: string;
	schema: ZodType<T>;
	abortSignal: AbortSignal;
}

/** A question to a structured query draft, on a small model. */
export interface QueryDrafter {
	draft<T>(request: DraftRequest<T>): Promise<T>;
}
