"use client";

import { type RefObject, useEffect, useState } from "react";

interface Focusable {
	readonly isConnected: boolean;
	focus(): void;
}

/**
 * Where focus goes when a sheet closes: back to what opened it, else to the
 * fallback when the opener went with something else that closed — a row of
 * a panel that is gone. Only focus the sheet took with it is handed back: if
 * the person has already put it somewhere else, it stays there.
 */
export function returnFocus(
	opener: unknown,
	fallback: Focusable | null | undefined,
	doc: { activeElement: unknown; body: unknown },
): void {
	if (doc.activeElement !== null && doc.activeElement !== doc.body) return;
	const back = isFocusable(opener) && opener.isConnected ? opener : fallback;
	if (back?.isConnected) back.focus();
}

function isFocusable(value: unknown): value is Focusable {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Focusable).focus === "function"
	);
}

/**
 * Hand focus back to whatever opened this when it unmounts. The opener is
 * read while this first renders — before any ref or effect of the sheet's
 * own has moved focus inside it, which would otherwise be what is recorded.
 */
export function useReturnFocus(fallback?: RefObject<HTMLElement | null>): void {
	const [opener] = useState(() =>
		typeof document === "undefined" ? null : document.activeElement,
	);
	useEffect(
		() => () => returnFocus(opener, fallback?.current, document),
		[opener, fallback],
	);
}
