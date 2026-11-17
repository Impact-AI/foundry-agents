"use client";

import { onIdle, thrifty } from "./render-tier";

/**
 * The workspace's lazy chunks, fetched at the start of a session: the
 * markdown renderer, the media overlay, the guide. Each is split behind the
 * moment that needs it, which is right; it also means each one's first
 * opening pays its fetch inside a press. A session's beginning is the
 * opposite moment, so once the page has had a long quiet beat the rest is
 * asked for — code only, immutable, no per-user server work. One latch, one
 * failure policy per chunk: a fetch that fails costs nothing but the head
 * start it did not get.
 */
let swept = false;

export function warmPanelsWhenIdle(timeout: number): () => void {
	if (swept) return () => {};
	return onIdle(() => {
		if (swept || thrifty()) return;
		swept = true;
		const chunks = [
			() =>
				import("./markdown/streamdown-lazy").then((m) => m.loadStreamdown()),
			() => import("../(app)/stage/MediaOverlay"),
			() => import("../(app)/guide/GuideTour"),
		];
		for (const chunk of chunks) {
			void chunk().catch(() => {
				/* the press pays the ordinary way */
			});
		}
	}, timeout);
}
