"use client";

import {
	Children,
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type CardFloor,
	type Grid,
	gridFor,
	type ViewSpan,
	viewAt,
	viewCount,
	viewHolding,
	viewSpan,
} from "@/src/stage/carousel";
import {
	IconButton,
	IconChevronLeft,
	IconChevronRight,
} from "../../components/controls";
import { prefersReducedMotion } from "../../components/motion";

/**
 * A row of views, each a grid of as many cards as the tile has room for: one
 * on a narrow stage, two or three across on a wide one, two rows down where
 * the tile is tall (`floor` is the least a card needs). The arrows, the
 * keyboard's arrows and a clearly sideways swipe each move a whole view, so a
 * step never shows a card again — and a swipe is not also a press. The track
 * snaps view by view; a short last view leaves its cells empty.
 */
export function Carousel({
	label,
	stepLabel,
	position,
	floor,
	children,
}: {
	label: string;
	/** The arrows' names, by direction. */
	stepLabel: (direction: "previous" | "next") => string;
	/** "1 of 9" or "1–4 of 9", already translated. */
	position: (span: ViewSpan, total: number) => string;
	/** The fewest pixels a card needs; a view holds as many as fit. */
	floor: CardFloor;
	children: ReactNode;
}) {
	const cards = Children.toArray(children);
	const count = cards.length;
	const track = useRef<HTMLDivElement>(null);
	const [grid, setGrid] = useState<Grid>({ cols: 1, rows: 1 });
	const perView = grid.cols * grid.rows;
	const [at, setAt] = useState(0);
	/** The view a step is scrolling to, until the track arrives there. */
	const heading = useRef<number | null>(null);
	/** The card leading the view in sight, kept across a change of grid. */
	const leading = useRef(0);
	const from = useRef<{ x: number; y: number } | null>(null);
	const swiped = useRef(false);
	const views = viewCount(count, perView);
	const many = views > 1;

	// Measure the room whenever the track's box changes, and reshape the views.
	useEffect(() => {
		const el = track.current;
		if (!el) return;
		const measure = () => {
			const style = getComputedStyle(el);
			const px = (v: string) => Number.parseFloat(v) || 0;
			const next = gridFor(
				el.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
				el.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
				px(style.columnGap),
				floor,
			);
			setGrid((was) =>
				was.cols === next.cols && was.rows === next.rows ? was : next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [floor]);

	// A new grid: put the card that led the view back in sight, without a scroll to watch.
	useEffect(() => {
		const el = track.current;
		const view = Math.min(
			viewCount(count, perView) - 1,
			viewHolding(leading.current, perView),
		);
		heading.current = null;
		setAt(view);
		const target = el?.children[view];
		if (el && target instanceof HTMLElement)
			el.scrollTo({ left: target.offsetLeft - el.offsetLeft });
	}, [perView, count]);

	const goTo = (view: number) => {
		const el = track.current;
		const next = Math.min(views - 1, Math.max(0, view));
		heading.current = next;
		leading.current = next * perView;
		setAt(next);
		const target = el?.children[next];
		if (el && target instanceof HTMLElement)
			el.scrollTo({
				left: target.offsetLeft - el.offsetLeft,
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});
	};
	// A step counts from where the track is going, not from where a smooth
	// scroll happens to be: two quick presses are two views.
	const step = (delta: number) => goTo((heading.current ?? at) + delta);

	const onScroll = () => {
		const el = track.current;
		const second = el?.children[1];
		if (!el) return;
		const stride =
			second instanceof HTMLElement
				? second.offsetLeft - (el.children[0] as HTMLElement).offsetLeft
				: el.clientWidth;
		const view = viewAt(el.scrollLeft, stride, views);
		// On the way to a step's view the passing views are not the position.
		if (heading.current !== null && view !== heading.current) return;
		heading.current = null;
		leading.current = view * perView;
		setAt(view);
	};

	const shape = {
		"--carousel-cols": grid.cols,
		"--carousel-rows": grid.rows,
	} as CSSProperties;

	return (
		<div
			className="carousel"
			data-many={many || undefined}
			{...(many
				? {
						role: "group",
						"aria-label": label,
						onKeyDown: (e: KeyboardEvent) => {
							if (e.key === "ArrowLeft") step(-1);
							else if (e.key === "ArrowRight") step(1);
							else return;
							e.preventDefault();
						},
						onPointerDown: (e: PointerEvent) => {
							if (e.pointerType === "mouse") return;
							from.current = { x: e.clientX, y: e.clientY };
						},
						onPointerUp: (e: PointerEvent) => {
							const start = from.current;
							from.current = null;
							if (!start) return;
							const dx = e.clientX - start.x;
							const dy = e.clientY - start.y;
							if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5)
								return;
							swiped.current = true;
							step(dx < 0 ? 1 : -1);
						},
						onClickCapture: (e: {
							preventDefault(): void;
							stopPropagation(): void;
						}) => {
							if (!swiped.current) return;
							swiped.current = false;
							e.preventDefault();
							e.stopPropagation();
						},
					}
				: {})}
		>
			<div
				className="carousel-track"
				ref={track}
				onScroll={onScroll}
				style={shape}
			>
				{Array.from({ length: views }, (_, view) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a view is its place in the row
					<div key={view} className="carousel-view">
						{cards.slice(view * perView, (view + 1) * perView)}
					</div>
				))}
			</div>
			{many ? (
				<div className="carousel-foot">
					<IconButton
						label={stepLabel("previous")}
						size="sm"
						onClick={() => step(-1)}
						disabled={at === 0}
					>
						<IconChevronLeft />
					</IconButton>
					<span className="carousel-position" aria-live="polite">
						{position(viewSpan(at, perView, count), count)}
					</span>
					<IconButton
						label={stepLabel("next")}
						size="sm"
						onClick={() => step(1)}
						disabled={at >= views - 1}
					>
						<IconChevronRight />
					</IconButton>
				</div>
			) : null}
		</div>
	);
}
