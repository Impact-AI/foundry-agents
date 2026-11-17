"use client";

import { type RefObject, useEffect } from "react";
import { prefersReducedMotion } from "../../components/motion";

/**
 * Bring a card drawn in the thread into view once, when it is ready: the
 * thread's own scroll follows text, and a card landing after the sentence it
 * belongs to is often past the fold.
 */
export function useRevealOnMount(
	ref: RefObject<HTMLElement | null>,
	ready: boolean,
) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: a stable ref; the effect keys on `ready` alone by design
	useEffect(() => {
		if (!ready) return;
		ref.current?.scrollIntoView({
			block: "end",
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
	}, [ready]);
}
