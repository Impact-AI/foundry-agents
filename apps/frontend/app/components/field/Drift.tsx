"use client";

import { useEffect, useRef, useState } from "react";
import { frameLoop } from "../frame-loop";
import { reducedMotionQuery } from "../motion";
import { modestHardware } from "../render-tier";
import {
	ALPHA,
	DEPTH,
	deal,
	MOTE_COUNT,
	PHASE,
	prng,
	SIZE,
	STRIDE,
	TINT,
	X,
	Y,
} from "./field-deal";

/**
 * The live field: soft motes drifting slowly across a gradient ground, the
 * near ones a little faster than the far. A sense of a room with air in it,
 * not a screensaver — the whole drift is a few pixels a second, redrawn at
 * `DRIFT_FPS`, allocating nothing per frame, and stood down whenever the tab
 * is behind another or the field is off the screen. Still under reduced
 * motion: one frame, drawn once, redrawn on resize. Drawn at least once
 * either way, so a stood-down loop is never the reason the canvas is empty.
 */
const DRIFT_FPS = 30;

/** Drift per depth, in box-widths per second. */
const SPEED = [0.004, 0.007, 0.011];

export function Drift() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the canvas exists only once mounted, so the effect runs again then
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const motes = deal();
		const rand = prng(0x4d4f5445);
		const styles = getComputedStyle(canvas);
		const tints = [
			styles.getPropertyValue("--field-tint").trim() || "rgb(110 168 255)",
			styles.getPropertyValue("--field-tint-2").trim() || "rgb(255 255 255)",
			styles.getPropertyValue("--field-tint-3").trim() || "rgb(190 150 255)",
		];
		const ceiling = modestHardware() ? 1 : 2;

		let w = 0;
		let h = 0;
		const resize = () => {
			const dpr = Math.min(window.devicePixelRatio || 1, ceiling);
			const rect = canvas.getBoundingClientRect();
			w = rect.width;
			h = rect.height;
			canvas.width = Math.max(1, Math.round(w * dpr));
			canvas.height = Math.max(1, Math.round(h * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};

		const draw = (t: number) => {
			ctx.clearRect(0, 0, w, h);
			for (let i = 0; i < MOTE_COUNT; i++) {
				const o = i * STRIDE;
				const x = (motes[o + X] ?? 0) * w;
				const y = (motes[o + Y] ?? 0) * h;
				const breath =
					0.75 + 0.25 * Math.sin(t * 0.0007 + (motes[o + PHASE] ?? 0));
				const r = (motes[o + SIZE] ?? 1) * (0.8 + 0.2 * breath);
				ctx.globalAlpha = Math.min(1, (motes[o + ALPHA] ?? 0) * breath);
				ctx.fillStyle = tints[motes[o + TINT] ?? 0] ?? tints[0] ?? "#fff";
				ctx.beginPath();
				ctx.arc(x, y, r, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.globalAlpha = 1;
		};

		const step = (dt: number) => {
			for (let i = 0; i < MOTE_COUNT; i++) {
				const o = i * STRIDE;
				const speed = SPEED[motes[o + DEPTH] ?? 0] ?? 0.004;
				const drift = Math.sin(motes[o + PHASE] ?? 0) * 0.3;
				let x = (motes[o + X] ?? 0) + speed * dt;
				let y = (motes[o + Y] ?? 0) - speed * dt * (0.6 + drift);
				if (x > 1.02) {
					x = -0.02;
					y = rand();
				}
				if (y < -0.02) {
					y = 1.02;
					x = rand();
				}
				motes[o + X] = x;
				motes[o + Y] = y;
			}
		};

		const motion = reducedMotionQuery();
		let last = 0;
		const tick = (now: number) => {
			if (last) step(Math.min((now - last) / 1000, 0.1));
			last = now;
			draw(now);
		};

		let release: (() => void) | null = null;
		const settle = () => {
			release?.();
			release = null;
			last = 0;
			draw(performance.now());
			if (!motion.matches)
				release = frameLoop(canvas, tick, { fps: DRIFT_FPS });
		};

		resize();
		settle();
		const observer = new ResizeObserver(() => {
			resize();
			draw(performance.now());
		});
		observer.observe(canvas.parentElement ?? canvas);
		motion.addEventListener("change", settle);

		return () => {
			release?.();
			observer.disconnect();
			motion.removeEventListener("change", settle);
		};
	}, [mounted]);

	if (!mounted) return null;
	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: paint only, never focusable
		<canvas ref={canvasRef} className="field-live" aria-hidden="true" />
	);
}
