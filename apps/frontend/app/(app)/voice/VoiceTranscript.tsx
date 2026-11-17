"use client";

import { useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { DocumentSource } from "@/src/chat/sources";
import { SourceChipList } from "../chat/Sources";
import { useStageActions } from "../stage/stage-actions";

export interface VoiceTurn {
	role: "user" | "assistant";
	text: string;
}

export interface WrittenTurn extends VoiceTurn {
	/** Minted when the turn is written down, so the list has a stable key. */
	id: string;
	/** The documents an answer drew on, as a typed reply's chips. */
	sources?: DocumentSource[];
}

/** How close to its foot the reader must be for the transcript to follow a line down. */
const PINNED_WITHIN_PX = 24;

/**
 * What was said on the channel, as it is written down, an answer's sources
 * under it. The box is a few lines high and, while the channel is open, the
 * only place the words are, so it follows its newest line for as long as
 * the reader is at its foot, as the thread does. It is a log with a name
 * that a keyboard can reach and scroll back, and each line says whose it is
 * to a reader who cannot see which side it is drawn on.
 */
export function VoiceTranscript({ turns }: { turns: WrittenTurn[] }) {
	const t = useTranslations("chat");
	const voice = useTranslations("voice");
	const actions = useStageActions();
	const box = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const shown = turns.length > 0;

	// A new line, or an answer's sources arriving under it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the turns changing is the event
	useLayoutEffect(() => {
		const el = box.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [turns]);

	// The lines settle after they arrive — a row of chips wraps, the text is
	// set larger — and a channel opened again starts at its foot.
	useEffect(() => {
		const el = box.current;
		const lines = el?.firstElementChild;
		if (!shown || !el || !lines) return;
		pinned.current = true;
		const ro = new ResizeObserver(() => {
			if (pinned.current) el.scrollTop = el.scrollHeight;
		});
		ro.observe(lines);
		return () => ro.disconnect();
	}, [shown]);

	const onScroll = () => {
		const el = box.current;
		if (!el) return;
		pinned.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_WITHIN_PX;
	};

	if (!shown) return null;
	return (
		<div
			className="voice-transcript"
			ref={box}
			onScroll={onScroll}
			role="log"
			aria-label={voice("transcriptLabel")}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
			tabIndex={0}
		>
			<div className="voice-transcript-lines">
				{turns.map((turn) => (
					<div key={turn.id} className="voice-turn">
						<p data-role={turn.role}>
							<span className="sr-only">
								{t(
									turn.role === "user" ? "speakerYou" : "speakerAssistant",
								)}{" "}
							</span>
							{turn.text}
						</p>
						{turn.sources ? (
							<SourceChipList
								label={t("sources")}
								sources={turn.sources}
								onOpen={actions.openDocument}
							/>
						) : null}
					</div>
				))}
			</div>
		</div>
	);
}
