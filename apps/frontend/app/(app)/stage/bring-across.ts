"use client";

import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { Section, Stage } from "@/src/stage/stage";
import { pageLeft, tileOf } from "@/src/stage/stage-pages";
import { prefersReducedMotion } from "../../components/motion";

/**
 * How long a press waits for its tile. A fetch that fails places nothing, and
 * a tile the assistant places much later must not pull the page across.
 */
const WAIT_MS = 10_000;

/**
 * On a phone the workspace is a row of pages — the conversation, then every
 * tile — and a tile placed off-screen stays there. When the person asked for
 * it by hand (the bar's Library, a card in the library, a record), the pager
 * brings that tile's page across once it is placed. When the assistant
 * places one mid-answer, the page stays on the conversation being read; the
 * strip under it lights the new page instead (StagePages).
 *
 * Returns `byHand(section, run)`: run what places the tile, and bring it
 * across when it lands. On a wide screen the workspace does not scroll
 * sideways, and the scroll is a no-op.
 */
export function useBringAcross(
	pager: RefObject<HTMLElement | null>,
	stage: Stage,
): (section: Section, run: () => void) => void {
	const wanted = useRef<{ section: Section; at: number } | null>(null);

	useEffect(() => {
		const want = wanted.current;
		const el = pager.current;
		if (!want || !el) return;
		if (Date.now() - want.at > WAIT_MS) {
			wanted.current = null;
			return;
		}
		if (!stage.some((i) => i.section === want.section)) return;
		wanted.current = null;
		const tile = tileOf(el, want.section);
		if (tile)
			el.scrollTo({
				left: pageLeft(tile, el),
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});
	}, [stage, pager]);

	return useCallback((section: Section, run: () => void) => {
		wanted.current = { section, at: Date.now() };
		run();
	}, []);
}
