"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { isEditable } from "@/src/editable";
import { guideScrollTo, placeCard, type Spot } from "@/src/stage/guide-place";
import { useCoarsePointer } from "../../components/coarse-pointer";
import { Button, IconButton, IconClose } from "../../components/controls";
import { prefersReducedMotion } from "../../components/motion";
import { useReturnFocus } from "../../components/use-return-focus";
import "./guide.css";

type Stop = { key: string; sel: string | null; pad?: number };

/** The tour, in the order a reader meets the workspace; a stop whose element is not on screen is dropped. */
const STOPS: readonly Stop[] = [
	{ key: "intro", sel: null },
	{ key: "chat", sel: ".composer" },
	{ key: "voice", sel: "[data-guide='voice']", pad: 7 },
	{ key: "openers", sel: ".landing-openers" },
	{ key: "stage", sel: ".workspace-main" },
	{ key: "account", sel: ".account-disc", pad: 7 },
];

type Live = Stop & { el: HTMLElement | null };

const sameSpot = (a: Spot | null, b: Spot | null) =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.top === b.top &&
		a.left === b.left &&
		a.width === b.width &&
		a.height === b.height);

function spotOf(el: HTMLElement, pad: number): Spot | null {
	const box = el.getBoundingClientRect();
	if (box.width === 0) return null;
	const radius = Number.parseFloat(getComputedStyle(el).borderRadius) || 0;
	return {
		top: box.top - pad,
		left: box.left - pad,
		width: box.width + pad * 2,
		height: box.height + pad * 2,
		radius: radius + pad,
	};
}

export function GuideTour({ onClose }: { onClose: () => void }) {
	const t = useTranslations("guide");
	const [stops, setStops] = useState<Live[]>([]);
	const [at, setAt] = useState(0);
	const [spot, setSpot] = useState<Spot | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const card = useRef<HTMLDivElement>(null);
	const stop = stops[at] ?? null;
	const last = stops.length > 0 && at >= stops.length - 1;

	const next = useCallback(
		() => setAt((i) => Math.min(i + 1, stops.length - 1)),
		[stops.length],
	);
	const back = useCallback(() => setAt((i) => Math.max(i - 1, 0)), []);

	useEffect(() => {
		const live = STOPS.map((s) => ({
			...s,
			el: s.sel ? document.querySelector<HTMLElement>(s.sel) : null,
		})).filter(
			(s) =>
				s.sel === null ||
				(s.el !== null && s.el.getBoundingClientRect().width > 0),
		);
		if (live.length < 2) {
			onClose();
			return;
		}
		setStops(live);
	}, [onClose]);

	useReturnFocus();
	useEffect(() => {
		card.current?.focus();
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			} else if (isEditable(e.target)) {
				// The page behind the tour is still the person's: a caret key in a field is the field's.
				return;
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				next();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				back();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, next, back]);

	useEffect(() => {
		const el = stop?.el;
		if (!el) return;
		const box = el.getBoundingClientRect();
		const bar = document.querySelector<HTMLElement>(".topbar");
		const to = guideScrollTo(
			{ top: box.top, height: box.height },
			{ height: window.innerHeight, scrollY: window.scrollY },
			bar?.offsetHeight ?? 0,
		);
		if (to === null) return;
		window.scrollTo({
			top: to,
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
	}, [stop]);

	// Where the light and the card are, every frame: the things pointed at move.
	useEffect(() => {
		const el = stop?.el ?? null;
		const pad = stop?.pad ?? 8;
		let frame = 0;
		const tick = () => {
			frame = requestAnimationFrame(tick);
			const found = el?.isConnected ? spotOf(el, pad) : null;
			setSpot((prev) => (sameSpot(prev, found) ? prev : found));
			const box = card.current?.getBoundingClientRect();
			if (!box) return;
			const to = placeCard(found, box, {
				width: window.innerWidth,
				height: window.innerHeight,
			});
			setPos((prev) =>
				prev && Math.abs(prev.x - to.x) < 0.5 && Math.abs(prev.y - to.y) < 0.5
					? prev
					: to,
			);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [stop]);

	const key = stop?.key ?? "intro";
	const coarse = useCoarsePointer();
	const copy = (part: "line" | "press"): string | null => {
		const touch = `stops.${key}.${part}Touch`;
		if (coarse && t.has(touch)) return t(touch);
		const plain = `stops.${key}.${part}`;
		return t.has(plain) ? t(plain) : null;
	};
	const line = copy("line");
	const press = copy("press");

	return (
		<div className="guide">
			<button
				type="button"
				className="guide-scrim"
				aria-label={t("advance")}
				onClick={last ? onClose : next}
			/>
			<div
				className={`guide-spot${spot ? "" : " guide-spot--none"}`}
				aria-hidden="true"
				style={
					spot
						? {
								top: `${spot.top}px`,
								left: `${spot.left}px`,
								width: `${spot.width}px`,
								height: `${spot.height}px`,
								borderRadius: `${spot.radius}px`,
							}
						: undefined
				}
			/>
			<div
				className="guide-card card-frame"
				role="dialog"
				aria-labelledby="guide-card-title"
				tabIndex={-1}
				ref={card}
				style={
					pos
						? { transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }
						: { transform: "translate3d(-9999px, 0, 0)" }
				}
			>
				<div className="card-head card-head--bar">
					<p className="eyebrow eyebrow--accent">
						{stop?.sel
							? t("step", { n: at, total: stops.length - 1 })
							: t("eyebrow")}
					</p>
					<IconButton
						label={t("close")}
						variant="ghost"
						size="sm"
						onClick={onClose}
					>
						<IconClose />
					</IconButton>
				</div>
				<div className="card-body guide-card-body" key={key}>
					<h2 className="guide-title" id="guide-card-title">
						{t(`stops.${key}.title`)}
					</h2>
					{line ? <p className="guide-line">{line}</p> : null}
					{press ? <p className="guide-press">{press}</p> : null}
					{last ? <p className="guide-again">{t("again")}</p> : null}
				</div>
				<div className="card-actions card-actions--split">
					<Button size="sm" onClick={back} disabled={at === 0}>
						{t("back")}
					</Button>
					<Button variant="primary" size="sm" onClick={last ? onClose : next}>
						{last ? t("done") : t("next")}
					</Button>
				</div>
			</div>
		</div>
	);
}
