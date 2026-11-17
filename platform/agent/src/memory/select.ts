import { eraseFromFoundryStore, foundryMemoryStore } from "../foundry/memory";
import { agentSettings, memoryStoreFor } from "../settings";
import type { MemoryDeps, MemoryStore } from "./interface";
import { memoryStore as ownMemoryStore } from "./store";

/**
 * The store the operator chose, behind the one interface the host holds:
 * `memory.store` in the `agent` document, read through the settings memo
 * at the first use of memory and held for the life of the process. Every
 * replica then runs one implementation from first turn to last — the two
 * keep their facts in different places, so a replica that switched halfway
 * would read from one and write to the other. A change to the setting
 * takes effect at the next restart, and the job's `agent` step reads it
 * afresh on each deploy. What the document names is read through
 * `memoryStoreFor`: on a private deployment the Foundry store is refused
 * and the own store runs.
 *
 * Choosing between implementations is this module's whole job, so it and
 * `history/select.ts` are the two places outside `foundry/` that import
 * from it (`contract/neutral.test.ts` holds everything else to that).
 */
export interface SelectedMemoryStore extends MemoryStore {
	/** The implementation this process runs, chosen at the first call. */
	selected(): Promise<MemoryStore>;
	/**
	 * The account going: everything remembered under it forgotten, in the
	 * store this process runs and in the other one. Nothing moves between
	 * the two when an operator changes `memory.store`, so the store no longer
	 * in use may still hold what it kept before the change, where no read, no
	 * export and no forget of the person's reaches it. An erase is the one
	 * thing that must. True when either store held something. Either store
	 * failing throws, so the erase stays unfinished; only the Foundry
	 * store's 404 is nothing to forget (`eraseFromFoundryStore`).
	 */
	erase(resourceId: string): Promise<boolean>;
}

export function memoryStore(deps: MemoryDeps): SelectedMemoryStore {
	let choosing: Promise<MemoryStore> | null = null;
	let chosen: MemoryStore | null = null;
	let started = false;

	function selected(): Promise<MemoryStore> {
		choosing ??= agentSettings()
			.then(({ memory }) => {
				chosen =
					memoryStoreFor(memory) === "own"
						? ownMemoryStore(deps)
						: foundryMemoryStore(deps);
				if (started) chosen.start();
				return chosen;
			})
			.catch((err) => {
				// A choice that failed is made again at the next use, never kept.
				choosing = null;
				throw err;
			});
		return choosing;
	}

	return {
		// The wrapper has no kind of its own until the setting is read; `selected()` answers.
		get kind() {
			if (!chosen)
				throw new Error("the memory store is chosen at its first use");
			return chosen.kind;
		},
		selected,
		read: async (resourceId) => (await selected()).read(resourceId),
		async statements(resourceId) {
			// As a store answers what it cannot read: the turn goes on without it.
			let store: MemoryStore;
			try {
				store = await selected();
			} catch (err) {
				console.error(
					"[memory] no store could be chosen, continuing without it:",
					(err as Error).message,
				);
				return null;
			}
			try {
				return await store.statements(resourceId);
			} catch (err) {
				console.error(
					"[memory] what is remembered could not be read, continuing without it:",
					(err as Error).message,
				);
				return null;
			}
		},
		update: async (resourceId, itemId, content) =>
			(await selected()).update(resourceId, itemId, content),
		remove: async (resourceId, itemId) =>
			(await selected()).remove(resourceId, itemId),
		forget: async (resourceId, options) =>
			(await selected()).forget(resourceId, options),
		async erase(resourceId) {
			const store = await selected();
			const here = await store.forget(resourceId, { erasing: true });
			// The other implementation, made for this and never started: its sweeper and its queue are not this process's.
			const elsewhere =
				store.kind === "own"
					? await eraseFromFoundryStore(deps, resourceId)
					: await ownMemoryStore(deps).forget(resourceId, { erasing: true });
			return here || elsewhere;
		},
		handOver: async (resourceId, threadId, said) =>
			(await selected()).handOver(resourceId, threadId, said),
		flush: async () => (await selected()).flush(),
		start() {
			started = true;
			// Chosen already: its sweeper starts now; otherwise when it is chosen.
			if (chosen) chosen.start();
			else void selected().catch(() => {});
		},
		async stop() {
			started = false;
			await chosen?.stop();
		},
	};
}
