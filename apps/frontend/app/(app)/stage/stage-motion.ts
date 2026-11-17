"use client";

import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import type { Instrument, Section, Stage } from "@/src/stage/stage";
import { STAGE_CAPACITY } from "@/src/stage/stage";
import { flipFrames, worthPlaying } from "@/src/stage/stage-flip";
import { prefersReducedMotion } from "../../components/motion";

/**
 * How the stage moves. A tile that arrives rises in (the sheet's `panel-in`);
 * a tile that leaves is held here for its fade before its cell is given up;
 * the ones that stay are measured before and after a change and played
 * from where they stood. Both stand down for a reader who asked for stillness.
 */
const TILE_EXIT_MS = 360;
const MOVE_MS = 640;

export interface StagedTile {
	instrument: Instrument;
	key: Section;
	leaving: boolean;
}

interface Held {
	instrument: Instrument;
	key: Section;
	at: number;
}

/** The stage with its departures still on it — derived during render, so a leaving tile's node stays continuous. */
export function useExitingStage(stage: Stage): StagedTile[] {
	const [state, setState] = useState<{ stage: Stage; held: Held[] }>({
		stage,
		held: [],
	});

	if (state.stage !== stage) {
		const now = new Set(stage.map((i) => i.section));
		const gone = state.stage
			.map((instrument, at) => ({ instrument, key: instrument.section, at }))
			.filter((h) => !now.has(h.key));
		const still = typeof window !== "undefined" && prefersReducedMotion();
		setState({
			stage,
			held: still
				? []
				: [
						...state.held.filter((h) => !now.has(h.key)),
						...gone.filter((g) => !state.held.some((h) => h.key === g.key)),
					],
		});
	}

	const holding = state.held.length > 0;
	useEffect(() => {
		if (!holding) return;
		const timer = setTimeout(
			() => setState((s) => (s.held.length ? { ...s, held: [] } : s)),
			TILE_EXIT_MS,
		);
		return () => clearTimeout(timer);
	}, [holding]);

	const list: StagedTile[] = stage.map((instrument) => ({
		instrument,
		key: instrument.section,
		leaving: false,
	}));
	for (const h of state.held) {
		if (list.length >= STAGE_CAPACITY) break;
		list.splice(Math.min(h.at, list.length), 0, {
			instrument: h.instrument,
			key: h.key,
			leaving: true,
		});
	}
	return list;
}

const tilesOf = (el: HTMLElement) =>
	el.querySelectorAll<HTMLElement>(".stage-tile[data-key]");

/**
 * First–last–invert–play over the tiles: after every render the boxes are
 * recorded; when the arrangement's signature changes, each tile that was
 * already there is played from where it was, its inner element counter-
 * scaled so the picture never changes shape (`stage-flip`).
 */
export function useFlip(
	root: RefObject<HTMLElement | null>,
	signature: string,
) {
	const [rects] = useState(() => new Map<string, DOMRect>());
	const [seen] = useState<{ signature: string | null }>(() => ({
		signature: null,
	}));

	const snapshot = useCallback(() => {
		const el = root.current;
		if (!el) return;
		rects.clear();
		for (const tile of tilesOf(el)) {
			const key = tile.dataset.key;
			if (key) rects.set(key, tile.getBoundingClientRect());
		}
	}, [root, rects]);

	useLayoutEffect(() => {
		const el = root.current;
		if (!el) return;
		const changed = seen.signature !== null && seen.signature !== signature;
		seen.signature = signature;
		if (changed && !prefersReducedMotion()) {
			for (const tile of tilesOf(el)) {
				const key = tile.dataset.key;
				const prev = key ? rects.get(key) : undefined;
				if (!prev) continue;
				const next = tile.getBoundingClientRect();
				const move = {
					dx: prev.left - next.left,
					dy: prev.top - next.top,
					sx: next.width ? prev.width / next.width : 1,
					sy: next.height ? prev.height / next.height : 1,
				};
				if (!worthPlaying(move)) continue;
				const frames = flipFrames(move);
				const timing = { duration: MOVE_MS, easing: "linear" };
				tile.animate(frames.tile, timing);
				tile
					.querySelector<HTMLElement>(":scope > .stage-tile-inner")
					?.animate(frames.inner, timing);
			}
		}
		snapshot();
	});

	useEffect(() => {
		const el = root.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => snapshot());
		ro.observe(el);
		return () => ro.disconnect();
	}, [root, snapshot]);
}
