"use client";

import { createContext, useContext } from "react";
import type { Section } from "@/src/stage/stage";

/**
 * What the row under the composer offers. Resolved by the workspace, which
 * holds the authored list and knows the stage; consumed inside CopilotKit's
 * input slot, which alone knows how to post a turn — a context because the
 * slot is module-scope and a prop cannot reach it.
 */
export interface SuggestionsValue {
	authored: readonly string[];
	sections: readonly Section[];
}

const SuggestionsContext = createContext<SuggestionsValue>({
	authored: [],
	sections: [],
});

export const SuggestionsProvider = SuggestionsContext.Provider;

export function useSuggestions(): SuggestionsValue {
	return useContext(SuggestionsContext);
}
