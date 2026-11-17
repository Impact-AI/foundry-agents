"use client";

import {
	CopilotChatMessageView,
	CopilotChatView,
	type CopilotChatViewProps,
	type UseAgentUpdate,
	useAgent,
} from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
	alreadyWaiting,
	atRest,
	joinQueued,
	type Queued,
	queueMore,
	REST_MS,
	sendAfter,
} from "@/src/chat/send-queue";
import { errorKey } from "@/src/errors";
import { Button, StatusLine } from "../../components/controls";
import { usePinnedFoot } from "../stage/pinned-foot";
import { type Say, VoicePane } from "../voice/VoicePane";
import { usePostTurn } from "../workspace/send-turn";
import { useVoiceChannel } from "../workspace/voice-context";
import { AttachmentQueue } from "./AttachmentQueue";
import { Composer } from "./Composer";
import { useChatNotices } from "./chat-notices-context";
import { TurnNotice } from "./TurnNotice";

/** How close to the foot the reader must be for the thread to follow a turn down. */
const PINNED_WITHIN_PX = 96;

/** Nothing of the agent's is followed where only whether it is the runtime's own is read. */
const NO_UPDATES: UseAgentUpdate[] = [];

/**
 * Whether an answer that ran in this view has just ended: once the thread
 * is at rest and has stayed there, so the seam between a tool's call and
 * the words after it says nothing. A thread opened at rest has not, and
 * neither has a run that left no answer — its notice says what happened.
 */
function useAnswered(
	isRunning: boolean,
	rest: boolean,
	lastIsAssistant: boolean,
): boolean {
	const [answered, setAnswered] = useState(false);
	const ran = useRef(false);
	useEffect(() => {
		if (isRunning) {
			ran.current = true;
			setAnswered(false);
			return;
		}
		if (!ran.current || !rest) return;
		if (!lastIsAssistant) {
			ran.current = false;
			return;
		}
		const timer = window.setTimeout(() => {
			ran.current = false;
			setAnswered(true);
		}, REST_MS);
		return () => window.clearTimeout(timer);
	}, [isRunning, rest, lastIsAssistant]);
	return answered;
}

/**
 * The conversation's column as we lay it out: the thread, which scrolls
 * inside the pane and follows a turn as long as the reader was at its
 * foot, then the foot — what has to be said beside the composer, the
 * pictures waiting to go, and the composer itself, under the voice pane
 * while the channel is open. The runtime's view is replaced whole, so the
 * column owns every box; the runtime still owns the messages, the run and
 * the attachments, which arrive as props.
 */
function ChatViewImpl({
	messageView,
	messages = [],
	isRunning = false,
	isConnecting = false,
	inputValue = "",
	onInputChange,
	onSubmitMessage,
	onStop,
	attachments = [],
	onRemoveAttachment,
	onAddFile,
	dragOver = false,
	onDragOver,
	onDragLeave,
	onDrop,
}: CopilotChatViewProps) {
	const t = useTranslations("chat");
	const common = useTranslations("common");
	const errors = useTranslations("errors");
	const voice = useVoiceChannel();
	const notices = useChatNotices();
	const scroller = useRef<HTMLElement>(null);
	const pinned = useRef(true);
	const [foot, setFoot] = useState<HTMLDivElement | null>(null);
	usePinnedFoot(foot);

	// A message sent while the assistant is still answering waits here and
	// goes once the answer is over (see src/chat/send-queue).
	const [queued, setQueued] = useState<Queued | null>(null);
	const uploading = attachments.some((a) => a.status === "uploading");
	const post = usePostTurn();
	// While the channel is open, typed words go into the session — words
	// alone: a picture waiting to go needs a typed turn, so it waits with them.
	// The thread is the session's while the channel is open and until its words are written.
	const voiceHolds = Boolean(voice?.open || voice?.held);
	// The thread is not open the moment the page is. Until the runtime has
	// said which agents it serves the page holds a stand-in for this one, and
	// for an instant after it loads or changes conversation the runtime is
	// still being asked about the thread: words handed over before either is
	// settled are let go of. So they wait here, where they can be seen and
	// taken back.
	const { isReady } = useAgent({ updates: NO_UPDATES });
	const opening = isConnecting || !isReady;
	const mustWait =
		voiceHolds || opening || queued !== null || !atRest(messages, isRunning);
	const submit = (text: string, say: Say | null) => {
		if (say && !attachments.length && say(text)) return;
		if (say || mustWait) {
			setQueued((was) => queueMore(was, text, true));
			return;
		}
		onSubmitMessage?.(text);
	};
	// A chip's or an opener's words wait here by the same rule as typed ones;
	// when nothing is in the way they are left to go as a turn of their own,
	// past the composer, whose draft and pictures are not theirs to take.
	// Words sent a moment ago are not in `messages` yet, so the outbox says
	// when some are on their way: they are waited behind like a run.
	const keep = useRef((_text: string, _busy: boolean): boolean => false);
	keep.current = (text, busy) => {
		if (!mustWait && !busy) return false;
		setQueued((was) =>
			alreadyWaiting(was, text) ? was : queueMore(was, text, false),
		);
		return true;
	};
	const outbox = voice?.outbox;
	useEffect(() => {
		outbox?.take((text, busy) => keep.current(text, busy));
		return () => outbox?.take(null);
	}, [outbox]);
	// Not while a live session holds the thread: a typed turn on it is refused
	// until the session's words are written. Nor while the thread is still
	// being opened. Only typed words wait for a picture still being prepared:
	// it is theirs to carry.
	const wait =
		queued === null || voiceHolds || opening
			? null
			: sendAfter(messages, isRunning, queued.typed && uploading);
	useEffect(() => {
		if (queued === null || wait === null) return;
		const timer = window.setTimeout(() => {
			setQueued(null);
			// Typed words go as the composer sends them, with its pictures;
			// a chip's go alone and leave the draft typed since.
			if (queued.typed) onSubmitMessage?.(queued.text);
			else void post(queued.text);
		}, wait);
		return () => window.clearTimeout(timer);
	}, [queued, wait, onSubmitMessage, post]);
	// Taking it back puts it in the field, ahead of anything typed since.
	const editQueued = () => {
		if (queued === null) return;
		onInputChange?.(
			inputValue.trim() ? joinQueued(queued.text, inputValue) : queued.text,
		);
		setQueued(null);
	};

	const last = messages[messages.length - 1];
	const answered = useAnswered(
		isRunning,
		atRest(messages, isRunning),
		last?.role === "assistant",
	);
	const shape = `${messages.length}:${
		typeof last?.content === "string" ? last.content.length : 0
	}:${isRunning ? 1 : 0}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the thread's shape changing is the event
	useEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [shape]);

	// The words settle after they arrive — markdown lands, a picture loads — and
	// the box itself shrinks when a notice or the keyboard takes room: the foot
	// follows both.
	useEffect(() => {
		const el = scroller.current;
		const content = el?.firstElementChild;
		if (!el || !content) return;
		const follow = () => {
			if (pinned.current) el.scrollTop = el.scrollHeight;
		};
		const ro = new ResizeObserver(follow);
		ro.observe(content);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const onScroll = () => {
		const el = scroller.current;
		if (!el) return;
		pinned.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_WITHIN_PX;
	};

	const Thread =
		typeof messageView === "function" ? messageView : CopilotChatMessageView;

	/** The composer and what stands beside it, with where its words go while the channel is open. */
	const typing = (say: Say | null) => (
		<>
			{queued !== null ? (
				<StatusLine
					className="chat-queued"
					action={
						<Button variant="ghost" size="sm" onClick={editQueued}>
							{t("queuedEdit")}
						</Button>
					}
				>
					{t(voiceHolds ? "queuedVoice" : "queued", {
						text: preview(queued.text),
					})}
				</StatusLine>
			) : null}
			<AttachmentQueue
				attachments={attachments}
				onRemove={onRemoveAttachment}
			/>
			<Composer
				value={inputValue}
				onChange={(next) => onInputChange?.(next)}
				onSubmit={(text) => submit(text, say)}
				onStop={onStop}
				isRunning={isRunning}
				uploading={uploading}
				onAddFile={onAddFile}
			/>
		</>
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the whole column takes a dropped picture; the keyboard's way is the composer's add menu
		<div
			className="chat-view"
			data-copilot-running={isRunning ? "true" : "false"}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			{/* A scrolling region a keyboard can reach, so the messages scroll without a pointer. */}
			<section
				className="chat-thread"
				ref={scroller}
				onScroll={onScroll}
				aria-label={t("threadLabel")}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
				tabIndex={0}
			>
				<div className="chat-thread-inner">
					<Thread messages={messages} isRunning={isRunning} />
				</div>
			</section>
			{/* Always in the tree, so the change of words is what a screen reader announces. */}
			<span className="sr-only" role="status">
				{isRunning ? t("answering") : ""}
			</span>
			{/* The end of an answer, in a region of its own: said once, when the thread is at rest. */}
			<span className="sr-only" role="status">
				{answered ? t("answered") : ""}
			</span>
			{dragOver ? (
				<div className="chat-drop" aria-hidden="true">
					{t("dropHere")}
				</div>
			) : null}
			<div className="chat-foot" ref={setFoot}>
				<TurnNotice />
				{notices.rejected ? (
					<StatusLine
						tone="danger"
						action={
							<Button
								variant="ghost"
								size="sm"
								onClick={notices.dismissRejected}
							>
								{common("dismiss")}
							</Button>
						}
					>
						{notices.rejected}
					</StatusLine>
				) : null}
				{notices.stageProblem ? (
					<StatusLine
						tone="danger"
						action={
							<Button
								variant="ghost"
								size="sm"
								onClick={notices.dismissStageProblem}
							>
								{common("dismiss")}
							</Button>
						}
					>
						{errors(errorKey(notices.stageProblem))}
					</StatusLine>
				) : null}
				{voice?.open ? <VoicePane composer={typing} /> : typing(null)}
			</div>
		</div>
	);
}

/** The queued words as the line under the thread shows them: one line, cut short. */
function preview(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

// A slot replacement must carry the original's statics to satisfy its type.
export const ChatView = Object.assign(ChatViewImpl, CopilotChatView);
