"use client";

import { useAgent } from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { type DocumentSource, mergeSources } from "@/src/chat/sources";
import { type ReloadableThread, reloadThread } from "@/src/chat/thread-reload";
import { errorKey } from "@/src/errors";
import { liveContextLines } from "@/src/stage/live-context";
import { runStageTool } from "@/src/stage/tools";
import type { VoiceErrorCode } from "@/src/voice/machine";
import { Button, StatusLine } from "../../components/controls";
import { useVoiceChannel } from "../workspace/voice-context";
import { headOf } from "./head";
import { previewState, useVoicePreview } from "./testing/voice-preview";
import { useLiveVoice } from "./useLiveVoice";
import {
	VoiceTranscript,
	type VoiceTurn,
	type WrittenTurn,
} from "./VoiceTranscript";
import { type MicAction, Waveform } from "./Waveform";
import "./voice.css";

const OWN_ERRORS = new Set([
	"insecure",
	"mic",
	"micDenied",
	"micNone",
	"capture",
	"micLost",
	"setup",
	"session",
	"sessionIdle",
	"sessionLength",
	"sessionExpired",
	"sessionLost",
	"sessionRestart",
]);

/** Endings after which opening again is the obvious next step: the thread carries on. */
const REOPENS = new Set([
	"sessionRestart",
	"sessionLost",
	"session",
	"setup",
	"micLost",
]);

/** Words typed into the open session; whether they went. */
export type Say = (text: string) => boolean;

/**
 * The voice pane, over the composer while the channel is open. The live
 * session's phase is the status line, the trace has the microphone at its
 * centre — pressed, it mutes: the session stays open and hears nothing —
 * what was said is written under it as it is said, with the documents an
 * answer drew on under it as a typed reply's are, and the disclosure
 * stays at the foot: a person who opens the channel without typing is told
 * too. The composer stays under the pane, and what is typed into it goes
 * into the open session as the person's words, answered by the voice;
 * while the session is not open to take them, they wait for the channel to
 * close (`say` is null). The session drives the stage through the same
 * handlers as a typed turn.
 *
 * The backend writes the spoken turns into the thread when the session
 * ends; once it says they are there, the thread is read again, so closing
 * the pane shows them in the chat with no reload. A session a replica's
 * restart ended is reopened on the same thread with one press.
 */
export function VoicePane({
	composer,
}: {
	/** The composer, drawn under the pane with where its words go. */
	composer?: (say: Say | null) => ReactNode;
}) {
	const t = useTranslations("voice");
	const tAi = useTranslations("ai");
	const common = useTranslations("common");
	const errors = useTranslations("errors");
	const channel = useVoiceChannel();
	const [turns, setTurns] = useState<WrittenTurn[]>([]);
	const [attempt, setAttempt] = useState(0);
	const threadId = channel?.threadId ?? "";
	const live = Boolean(channel?.capability.live);

	const show = useCallback((turn: VoiceTurn) => {
		setTurns((all) => [...all, { ...turn, id: crypto.randomUUID() }]);
	}, []);
	// Under the answer just spoken: the session sends them once its response is done.
	const drewOn = useCallback((sources: DocumentSource[]) => {
		setTurns((all) => {
			const at = all.findLastIndex((turn) => turn.role === "assistant");
			const answer = all[at];
			if (!answer) return all;
			const next = [...all];
			next[at] = {
				...answer,
				sources: mergeSources(answer.sources ?? [], sources),
			};
			return next;
		});
	}, []);

	// The thread read again once the session's words are in it: what a reload would show.
	const { agent } = useAgent({ updates: [] });
	const thread = useRef(agent);
	thread.current = agent;
	// The read the session's last word started, so the thread is let go only once it is back.
	const reading = useRef<Promise<unknown> | null>(null);
	const hold = channel?.hold;
	const onHeld = useCallback(
		(held: boolean) => {
			if (held) return hold?.(true);
			const read = reading.current;
			reading.current = null;
			void (read ?? Promise.resolve()).finally(() => hold?.(false));
		},
		[hold],
	);
	const onSettled = useCallback(
		(written: number) => {
			if (written <= 0) return;
			const reloadable: ReloadableThread = {
				get threadId() {
					return thread.current.threadId;
				},
				get isRunning() {
					return thread.current.isRunning;
				},
				setMessages: (messages) =>
					thread.current.setMessages(
						messages as Parameters<typeof thread.current.setMessages>[0],
					),
			};
			reading.current = reloadThread(reloadable, threadId).catch(() => false);
		},
		[threadId],
	);

	const handlers = channel?.handlers;
	const onToolCall = useCallback(
		(name: string, args: Record<string, unknown>) =>
			handlers
				? runStageTool(handlers, name, args)
				: Promise.resolve("The stage is not available."),
		[handlers],
	);
	const stage = channel?.stage ?? [];
	const screen = useMemo(() => liveContextLines(stage), [stage]);

	const preview = useVoicePreview();
	const voice = useLiveVoice(live && Boolean(channel) && !preview, {
		locale: channel?.locale ?? "en",
		threadId,
		attempt,
		onTurn: show,
		onSources: drewOn,
		onToolCall,
		screen,
		onSettled,
		onHeld,
	});
	const state = preview ? previewState(preview) : voice.state;

	if (!channel) return null;
	const close = () => channel.setOpen(false);

	const errorLine = (code: VoiceErrorCode) =>
		OWN_ERRORS.has(code) ? t(`errors.${code}`) : errors(errorKey(code));

	if (!live) {
		return (
			<section className="voice-pane" aria-label={t("heading")}>
				<StatusLine
					tone="idle"
					action={
						<Button size="sm" onClick={close}>
							{t("stop")}
						</Button>
					}
				>
					{t("unavailable")}
				</StatusLine>
				{composer?.(null)}
				<p className="ai-line">{tAi("voice")}</p>
			</section>
		);
	}

	const micAction: MicAction =
		state.phase === "connecting"
			? "wait"
			: state.phase === "error" || state.phase === "idle"
				? "off"
				: state.micOpen
					? "mute"
					: "unmute";
	const micLabel =
		micAction === "mute"
			? t("mute")
			: micAction === "unmute"
				? t("unmute")
				: micAction === "wait"
					? t("status.connecting")
					: t("micOff");
	const micWord =
		micAction === "mute"
			? t("muteWord")
			: micAction === "unmute"
				? t("unmuteWord")
				: null;
	const head = headOf(state.phase);
	const statusLine =
		state.phase === "thinking" && state.pendingTools > 0
			? t("working")
			: state.phase === "listening" && !state.micOpen
				? t("status.muted")
				: t(`status.${head.status}`);
	const reopen = () => setAttempt((n) => n + 1);
	const open =
		state.phase === "listening" ||
		state.phase === "thinking" ||
		state.phase === "speaking";

	return (
		<section className="voice-pane" aria-label={t("heading")}>
			<div className="voice-head">
				<StatusLine tone={head.tone} bare strong>
					<span className="voice-status" data-state={state.phase}>
						{statusLine}
					</span>
					<span className="voice-engine">{t("engineLive")}</span>
				</StatusLine>
				<Button size="sm" className="voice-exit" onClick={close}>
					{t("stop")}
				</Button>
			</div>
			{state.error ? (
				<StatusLine
					tone="danger"
					action={
						REOPENS.has(state.error) ? (
							<Button variant="ghost" size="sm" onClick={reopen}>
								{t("reopen")}
							</Button>
						) : (
							<Button variant="ghost" size="sm" onClick={close}>
								{common("dismiss")}
							</Button>
						)
					}
				>
					{errorLine(state.error)}
				</StatusLine>
			) : null}
			{state.blocked ? (
				<StatusLine tone="danger">{t("blocked")}</StatusLine>
			) : null}
			{state.unanswered ? (
				<StatusLine tone="idle">{t("unanswered")}</StatusLine>
			) : null}
			{state.typedRefused ? (
				<StatusLine tone="idle">
					{t(state.typedRefused === "fast" ? "typedTooFast" : "typedFull")}
				</StatusLine>
			) : null}
			{voice.unheard && !preview ? (
				<p className="voice-hint" role="status">
					{t("unheard")}
				</p>
			) : null}
			<Waveform
				analyser={voice.analyser}
				phase={state.phase}
				micAction={micAction}
				micLabel={micLabel}
				micWord={micWord}
				onMic={voice.toggleMic}
			/>
			<VoiceTranscript turns={turns} />
			{composer?.(open && !preview ? voice.say : null)}
			<p className="ai-line">{tAi("voice")}</p>
		</section>
	);
}
