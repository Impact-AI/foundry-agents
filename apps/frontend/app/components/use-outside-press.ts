"use client";

import { type RefObject, useEffect } from "react";

/** Dismiss on a press outside the panel, and on Escape. */
export function useOutsidePress(
	panelRef: RefObject<HTMLElement | null>,
	onDismiss: () => void,
	active = true,
): void {
	useEffect(() => {
		if (!active) return;
		const onPointerDown = (e: PointerEvent) => {
			const panel = panelRef.current;
			if (!panel || !(e.target instanceof Node) || !e.target.isConnected)
				return;
			if (!panel.contains(e.target)) onDismiss();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onDismiss();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [active, panelRef, onDismiss]);
}
