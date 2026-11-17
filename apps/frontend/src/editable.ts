/** The part of an element this reads: enough to tell a field from anything else. */
interface FocusTarget {
	tagName?: string;
	isContentEditable?: boolean;
}

/**
 * Whether a key pressed on `target` is the field's own: text being typed or
 * a choice being moved through. A page-wide shortcut leaves those keys to
 * the field, so the caret still moves in a composer the shortcut sits over.
 */
export function isEditable(target: unknown): boolean {
	const el = (target ?? {}) as FocusTarget;
	if (el.isContentEditable) return true;
	const tag = el.tagName?.toUpperCase();
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
