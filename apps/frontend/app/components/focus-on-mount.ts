/** A ref callback that moves focus to the element the moment it mounts — a dialog's first control, a field that just opened. */
export function focusOnMount(el: HTMLElement | null): void {
	el?.focus();
}
