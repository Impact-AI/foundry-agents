"use client";

import { useTranslations } from "next-intl";
import { type HTMLAttributes, useEffect, useRef, useState } from "react";
import {
	FIRST_LINE_MS,
	pickLine,
	poolFor,
	RESUME_MS,
	type ThinkingPool,
	TYPE_MS,
} from "@/src/stage/thinking-lines";
import { prefersReducedMotion } from "../../components/motion";
import "./thinking.css";

/**
 * The wait under the assistant's turn: the dot, and one line beside it,
 * typed on after a beat and kept until the words arrive. The cursor is
 * remounted at every seam of a turn — each run a tool call opens — and a
 * mount inside `RESUME_MS` of the last carries the same wait on rather than
 * drawing a fresh line. Decorative to a screen reader: the thread's status
 * line (`ChatView`) already says a run is in flight.
 */
let wait: { began: number; line: string | null; left: number | null } | null =
	null;
let lastLine: string | null = null;

function carriedWait(now: number) {
	if (!wait) return null;
	return wait.left === null || now - wait.left < RESUME_MS ? wait : null;
}

export function ThinkingCursor({
	className,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	const t = useTranslations("thinking");
	const [carried] = useState(() => carriedWait(Date.now())?.line ?? null);
	const [line, setLine] = useState<string | null>(carried);

	const draw = useRef<(pool: ThinkingPool) => string[]>(() => []);
	draw.current = (pool) => {
		const block = t.raw(pool);
		return Array.isArray(block) ? (block as string[]) : [];
	};

	useEffect(() => {
		const now = Date.now();
		const mine = carriedWait(now) ?? { began: now, line: null, left: null };
		mine.left = null;
		wait = mine;
		let opening: ReturnType<typeof setTimeout> | undefined;
		if (mine.line === null) {
			opening = setTimeout(
				() => {
					const picked = pickLine(
						draw.current(poolFor(Math.random())),
						lastLine,
						Math.random(),
					);
					mine.line = picked;
					if (picked) lastLine = picked;
					setLine(picked);
				},
				Math.max(0, FIRST_LINE_MS - (now - mine.began)),
			);
		}
		return () => {
			clearTimeout(opening);
			mine.left = Date.now();
		};
	}, []);

	return (
		<div
			className={`thinking-cursor${className ? ` ${className}` : ""}`}
			{...props}
		>
			<span className="thinking-dot" />
			{line ? <TypedLine line={line} whole={line === carried} /> : null}
		</div>
	);
}

/** One line, typed on behind a caret; whole for a line the reader already watched arrive. */
function TypedLine({ line, whole }: { line: string; whole: boolean }) {
	const chars = Array.from(line);
	const [count, setCount] = useState(() =>
		whole || prefersReducedMotion() ? chars.length : 0,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — a wait's line never changes under it
	useEffect(() => {
		if (count >= chars.length) return;
		const start = Date.now();
		const tick = setInterval(() => {
			const done = Math.min(
				chars.length,
				Math.floor((Date.now() - start) / TYPE_MS),
			);
			setCount(done);
			if (done >= chars.length) clearInterval(tick);
		}, TYPE_MS);
		return () => clearInterval(tick);
	}, []);

	const typing = count < chars.length;
	return (
		<span className="thinking-line" aria-hidden="true">
			{chars.slice(0, count).join("")}
			{typing && <span className="thinking-caret" />}
		</span>
	);
}
