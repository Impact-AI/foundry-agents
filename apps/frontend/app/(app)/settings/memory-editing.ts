import type { RememberedItem } from "@/src/person";
import type { Send } from "@/src/route-call";
import { removeMemoryItem, saveMemoryItem } from "./person-calls";

/**
 * The memory card's state as data: what is remembered, newest first, and at
 * most one statement open for a correction. Opening and leaving an edit are
 * transitions and never calls; saving is a call only when the draft changed
 * something and says something.
 */
export interface MemoryEditing {
	items: RememberedItem[];
	/** The statement being corrected and its draft; null while the list is read. */
	editing: { id: string; draft: string } | null;
}

export function reading(items: RememberedItem[]): MemoryEditing {
	return { items, editing: null };
}

export function editing(state: MemoryEditing, id: string): MemoryEditing {
	const item = state.items.find((i) => i.id === id);
	return item ? { ...state, editing: { id, draft: item.content } } : state;
}

export function isEditSavable({ items, editing }: MemoryEditing): boolean {
	if (!editing?.draft.trim()) return false;
	return items.find((i) => i.id === editing.id)?.content !== editing.draft;
}

/** Writes the draft and reads back what was kept; a refusal keeps the draft and answers its code. */
export async function saveDraft(
	state: MemoryEditing,
	send: Send = fetch,
): Promise<{ state: MemoryEditing; code?: string }> {
	if (!state.editing || !isEditSavable(state)) return { state };
	const result = await saveMemoryItem(
		state.editing.id,
		state.editing.draft,
		send,
	);
	if (!result.item) return { state, code: result.code };
	const saved = result.item;
	return {
		state: reading([saved, ...state.items.filter((i) => i.id !== saved.id)]),
	};
}

/** Forgets one statement; the list loses it when the backend agrees. */
export async function removeItem(
	state: MemoryEditing,
	id: string,
	send: Send = fetch,
): Promise<{ state: MemoryEditing; code?: string }> {
	const result = await removeMemoryItem(id, send);
	if (result.code) return { state, code: result.code };
	return { state: reading(state.items.filter((i) => i.id !== id)) };
}
