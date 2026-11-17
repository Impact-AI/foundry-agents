"use client";

import { useEffect } from "react";

/**
 * Field measurement, on the way out: time to first byte, first paint, the
 * worst interaction, and a short sample of frame timing, sent as one beacon
 * when the page is hidden. Nothing that identifies a person is in it. A
 * loading failure names itself here too (`reportLoadFailure`), so a chunk
 * that never arrived in production is a log line and not a silent blank.
 */
const ENDPOINT = "/api/vitals";
const SAMPLE_MS = 10_000;
const LONG_FRAME_MS = 50;
const STR = 120;

const failures: string[] = [];

export function reportLoadFailure(what: string): void {
	console.error(`[loading] ${what}`);
	if (failures.length < 5) failures.push(what.slice(0, STR));
}

type Report = {
	path: string;
	ttfb?: number;
	fcp?: number;
	inp?: number;
	inpTarget?: string;
	longFrames?: number;
	worstFrame?: number;
	sampled?: number;
	viewport?: number;
	failures?: string[];
};

function nameOf(node: unknown): string | undefined {
	if (!(node instanceof Element)) return undefined;
	const cls = (node.className || "").toString().trim().split(/\s+/)[0] ?? "";
	return (cls ? `${node.tagName}.${cls}` : node.tagName).slice(0, STR);
}

export function Vitals() {
	useEffect(() => {
		const report: Report = { path: location.pathname };
		const observers: PerformanceObserver[] = [];
		const observe = (
			type: string,
			handler: (entries: PerformanceEntryList) => void,
			options: Record<string, unknown> = {},
		) => {
			try {
				const po = new PerformanceObserver((list) =>
					handler(list.getEntries()),
				);
				po.observe({ type, buffered: true, ...options });
				observers.push(po);
			} catch {
				// An observer type this browser lacks is a field left empty.
			}
		};

		try {
			const nav = performance.getEntriesByType("navigation")[0] as
				| PerformanceNavigationTiming
				| undefined;
			if (nav) report.ttfb = Math.round(nav.responseStart);
		} catch {
			// As above.
		}
		observe("paint", (entries) => {
			for (const e of entries)
				if (e.name === "first-contentful-paint")
					report.fcp = Math.round(e.startTime);
		});
		observe(
			"event",
			(entries) => {
				for (const e of entries) {
					const ev = e as PerformanceEventTiming & { interactionId?: number };
					if (!ev.interactionId) continue;
					const ms = Math.round(ev.duration);
					if (ms > (report.inp ?? 0)) {
						report.inp = ms;
						report.inpTarget = nameOf(ev.target);
					}
				}
			},
			{ durationThreshold: 40 },
		);

		let frames = 0;
		let long = 0;
		let worst = 0;
		let raf = 0;
		const started = performance.now();
		let last = started;
		const tick = (now: number) => {
			const gap = now - last;
			last = now;
			frames++;
			if (gap > LONG_FRAME_MS) long++;
			if (gap > worst) worst = gap;
			raf = now - started < SAMPLE_MS ? requestAnimationFrame(tick) : 0;
		};
		raf = requestAnimationFrame(tick);

		let sent = false;
		const send = () => {
			if (sent) return;
			sent = true;
			try {
				for (const po of observers) po.takeRecords?.();
				if (frames > 1) {
					report.longFrames = long;
					report.worstFrame = Math.round(worst);
					report.sampled = frames;
				}
				report.viewport = window.innerWidth;
				if (failures.length) report.failures = [...failures];
				navigator.sendBeacon?.(
					ENDPOINT,
					new Blob([JSON.stringify(report)], { type: "application/json" }),
				);
			} catch {
				// A beacon that fails to send is a measurement lost, nothing more.
			}
		};
		const onHide = () => {
			if (document.visibilityState === "hidden") send();
		};
		document.addEventListener("visibilitychange", onHide);
		window.addEventListener("pagehide", send);
		return () => {
			if (raf) cancelAnimationFrame(raf);
			for (const po of observers) po.disconnect();
			document.removeEventListener("visibilitychange", onHide);
			window.removeEventListener("pagehide", send);
		};
	}, []);
	return null;
}
