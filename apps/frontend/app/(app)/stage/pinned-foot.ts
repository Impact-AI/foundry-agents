"use client";

import { useEffect } from "react";

/**
 * `--composer-fixed-h`: how much of the viewport's foot a control pinned
 * there covers — on a phone the composer, or the voice pane standing in for
 * it. Read off the computed position, so the stylesheet stays the one place
 * that decides where the control stands; 0 whenever it is in flow.
 */
export function usePinnedFoot(el: HTMLElement | null): void {
	useEffect(() => {
		if (!el) return;
		const root = document.documentElement;
		const publish = () => {
			const fixed = getComputedStyle(el).position === "fixed";
			root.style.setProperty(
				"--composer-fixed-h",
				fixed ? `${el.offsetHeight}px` : "0px",
			);
		};
		publish();
		const ro = new ResizeObserver(publish);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--composer-fixed-h");
		};
	}, [el]);
}
