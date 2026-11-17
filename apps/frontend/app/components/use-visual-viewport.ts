"use client";

import { useEffect } from "react";

/**
 * The visual viewport, written onto `<html>` for the stylesheet: its height
 * as `--vvh` and its top as `--vvt`, so the workspace can size itself to
 * what a phone keyboard leaves rather than to `100dvh`; and
 * `data-vv-keyboard` while the keyboard is up, which is when the strip
 * stands down and the composer follows the viewport.
 */
const KEYBOARD_MIN_PX = 120;

function useVisualViewport(): void {
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const root = document.documentElement;
		const write = () => {
			root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
			root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
			if (window.innerHeight - vv.height > KEYBOARD_MIN_PX)
				root.setAttribute("data-vv-keyboard", "");
			else root.removeAttribute("data-vv-keyboard");
		};
		write();
		vv.addEventListener("resize", write);
		vv.addEventListener("scroll", write);
		return () => {
			vv.removeEventListener("resize", write);
			vv.removeEventListener("scroll", write);
			root.style.removeProperty("--vvh");
			root.style.removeProperty("--vvt");
			root.removeAttribute("data-vv-keyboard");
		};
	}, []);
}

export function VisualViewport(): null {
	useVisualViewport();
	return null;
}
