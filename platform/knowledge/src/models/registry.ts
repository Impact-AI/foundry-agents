import {
	processSingleton,
	resetSingleton,
	setSingleton,
} from "@platform/config";
import { azureQueryDrafter } from "./azure";
import type { QueryDrafter } from "./contract";

/**
 * Which drafter answers in this process. The Azure OpenAI one is built on
 * first use when nothing has been wired, so a bare deployment works; an app
 * wires its own and a test wires a stand-in.
 */

const KEY = "knowledge:query-drafter";

export function wireQueryDrafter(drafter: QueryDrafter): void {
	setSingleton(KEY, drafter);
}

/** Forget the wiring, so the next use builds the Azure default again. */
export function resetQueryDrafter(): void {
	resetSingleton(KEY);
}

export function queryDrafter(): QueryDrafter {
	return processSingleton(KEY, () => azureQueryDrafter());
}
