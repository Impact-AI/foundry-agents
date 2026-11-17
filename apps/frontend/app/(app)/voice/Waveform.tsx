"use client";

import { useEffect, useRef } from "react";
import type { VoicePhase } from "@/src/voice/machine";
import { IconButton, IconMic, IconMicOff } from "../../components/controls";
import { frameLoop } from "../../components/frame-loop";
import { prefersReducedMotion } from "../../components/motion";

/**
 * The live audio trace: the person's voice while the channel listens, the
 * assistant's reply while it speaks, and a slow sweep when there is no
 * signal so the scope never looks dead. The microphone control sits at the
 * centre of the trace, which is the reason this is a canvas and not a bar:
 * it should be obvious where to press — and it says in a word what a press
 * does, since a microphone icon alone reads as a state, not a control.
 * There is no stop: the person stops the voice the way they would a
 * person, by speaking over it.
 */
const TRACE_HEADROOM = 0.6;
const TRACE_FPS = 60;
const IDLE_PHASE_RATE = 1.8;

export type MicAction = "mute" | "unmute" | "wait" | "off";

export function Waveform({
	analyser,
	phase,
	micAction,
	micLabel,
	micWord,
	onMic,
}: {
	analyser: AnalyserNode | null;
	phase: VoicePhase;
	micAction: MicAction;
	micLabel: string;
	/** The word under the control, when it can be pressed. */
	micWord: string | null;
	onMic: () => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const styles = getComputedStyle(canvas);
		const accent = styles.getPropertyValue("--accent").trim() || "#7fb2ff";
		const grid = styles.getPropertyValue("--line").trim() || "#fff2";
		const fftSize = analyser?.fftSize ?? 2048;
		const data = new Uint8Array(fftSize);
		let sweep = 0;
		let last = 0;

		const resize = () => {
			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
			canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(canvas);

		const still = prefersReducedMotion();
		const draw = (now: number) => {
			const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
			last = now;
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			const mid = h / 2;
			ctx.clearRect(0, 0, w, h);

			ctx.lineWidth = 1;
			ctx.strokeStyle = grid;
			ctx.beginPath();
			ctx.moveTo(0, mid);
			ctx.lineTo(w, mid);
			ctx.stroke();

			let hasSignal = false;
			if (analyser) {
				analyser.getByteTimeDomainData(data);
				for (let i = 0; i < data.length; i += 32) {
					if (Math.abs((data[i] ?? 128) - 128) > 2) {
						hasSignal = true;
						break;
					}
				}
			}

			ctx.lineWidth = 2;
			ctx.lineJoin = "round";
			ctx.strokeStyle = accent;
			ctx.shadowColor = accent;
			ctx.shadowBlur = hasSignal ? 10 : 4;
			ctx.beginPath();
			if (still) {
				// Reduced motion: the line is drawn and does not move; the status line says what the channel is doing.
				ctx.moveTo(0, mid);
				ctx.lineTo(w, mid);
			} else if (hasSignal) {
				const step = w / data.length;
				for (let i = 0; i < data.length; i++) {
					const v = ((data[i] ?? 128) - 128) / 128;
					const y = mid + v * (mid * TRACE_HEADROOM);
					if (i === 0) ctx.moveTo(0, y);
					else ctx.lineTo(i * step, y);
				}
			} else {
				sweep += IDLE_PHASE_RATE * dt;
				for (let x = 0; x <= w; x += 4) {
					const y =
						mid + Math.sin(x / 48 + sweep) * Math.sin(sweep / 3) * mid * 0.12;
					if (x === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
			}
			ctx.stroke();
			ctx.shadowBlur = 0;
		};

		const release = frameLoop(canvas, draw, { fps: TRACE_FPS });
		return () => {
			release();
			ro.disconnect();
		};
	}, [analyser]);

	const pressable = micAction !== "wait" && micAction !== "off";
	const muted = micAction === "unmute";
	return (
		<div
			className="waveform"
			data-phase={phase}
			data-muted={muted || undefined}
		>
			{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: paint only, never focusable */}
			<canvas ref={canvasRef} className="waveform-canvas" aria-hidden="true" />
			<div className="waveform-controls">
				<IconButton
					label={micLabel}
					size="lg"
					variant={micAction === "unmute" ? "quiet" : "primary"}
					className="waveform-mic"
					data-action={micAction}
					aria-pressed={pressable ? muted : undefined}
					disabled={!pressable}
					onClick={onMic}
				>
					{muted ? <IconMicOff /> : <IconMic />}
				</IconButton>
				{micWord ? (
					<span className="waveform-word" aria-hidden="true">
						{micWord}
					</span>
				) : null}
			</div>
		</div>
	);
}
