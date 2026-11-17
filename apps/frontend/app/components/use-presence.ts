"use client";

import { useEffect, useState } from "react";
import { prefersReducedMotion } from "./motion";

/**
 * Keep a closing panel mounted for its exit animation — and not at all for a
 * reader who asked for reduced motion, for whom a close is a cut.
 */
export function usePresence(
	open: boolean,
	exitMs: number,
): { present: boolean; closing: boolean } {
	const [present, setPresent] = useState(open);
	const [closing, setClosing] = useState(false);
	useEffect(() => {
		if (open) {
			setPresent(true);
			setClosing(false);
			return;
		}
		if (!present) return;
		if (prefersReducedMotion()) {
			setPresent(false);
			return;
		}
		setClosing(true);
		const timer = setTimeout(() => {
			setPresent(false);
			setClosing(false);
		}, exitMs);
		return () => clearTimeout(timer);
	}, [open, present, exitMs]);
	return { present, closing };
}
