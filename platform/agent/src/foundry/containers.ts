import type { ContainerDefinition } from "@platform/cosmos";
import { historyContainer } from "./history";
import { indexContainers } from "./threads";

/** The containers the thread index and the own history read, for an app's start to verify and a test to create. */
export const threadContainers: readonly ContainerDefinition[] = [
	...indexContainers,
	historyContainer,
];
