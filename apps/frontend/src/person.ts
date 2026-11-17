/**
 * The person's own fields as a form holds them: the bounds the backend
 * keeps, a draft of the three texts, and what a draft changes. Pure, so the
 * settings card, the route that forwards an edit and the tests read one
 * answer. Bounds mirror the backend's; it refuses again, this is for an
 * honest field.
 */
export const PERSON_NAME_MAX = 60;
export const PERSON_TEXT_MAX = 1000;

export interface Person {
	name: string | null;
	about: string | null;
	preferences: string | null;
}

export interface PersonPatch {
	name?: string;
	about?: string | null;
	preferences?: string | null;
}

/** One statement the assistant remembers about the person, as the backend answers it. */
export interface RememberedItem {
	id: string;
	content: string;
	/** ISO, UTC: when the assistant or the person last wrote it. */
	updatedAt: string;
}

/** Everything the assistant remembers about the person, newest first. */
export interface Remembered {
	items: RememberedItem[];
}

/** The longest statement a correction keeps: the backend caps it here too. */
export const MEMORY_ITEM_MAX = 500;

export type PersonDraft = Record<keyof Person, string>;

export function draftOf(person: Person): PersonDraft {
	return {
		name: person.name ?? "",
		about: person.about ?? "",
		preferences: person.preferences ?? "",
	};
}

/** What saving the draft would send: only the fields that changed, trimmed; null when nothing did. */
export function changesOf(
	saved: PersonDraft,
	draft: PersonDraft,
): PersonPatch | null {
	const patch: PersonPatch = {};
	if (draft.name.trim() !== saved.name.trim()) patch.name = draft.name.trim();
	for (const key of ["about", "preferences"] as const) {
		if (draft[key].trim() !== saved[key].trim())
			patch[key] = draft[key].trim() || null;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

/** A draft that would save: a name that is not blank, every field in bounds. */
export function isSavable(draft: PersonDraft): boolean {
	return (
		draft.name.trim().length > 0 &&
		draft.name.length <= PERSON_NAME_MAX &&
		draft.about.length <= PERSON_TEXT_MAX &&
		draft.preferences.length <= PERSON_TEXT_MAX
	);
}

function text(value: unknown, max: number): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string" || value.length > max) return undefined;
	return value.trim() || null;
}

/** A request body's edit, each field checked; null for a body with nothing usable in it. */
export function readPersonPatch(body: unknown): PersonPatch | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	const patch: PersonPatch = {};
	if ("name" in b) {
		const name = text(b.name, PERSON_NAME_MAX);
		if (!name) return null;
		patch.name = name;
	}
	for (const key of ["about", "preferences"] as const) {
		if (!(key in b)) continue;
		const value = text(b[key], PERSON_TEXT_MAX);
		if (value === undefined) return null;
		patch[key] = value;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}
