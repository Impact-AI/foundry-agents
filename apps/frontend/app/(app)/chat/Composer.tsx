"use client";

import { useTranslations } from "next-intl";
import {
	type KeyboardEvent,
	useCallback,
	useLayoutEffect,
	useRef,
} from "react";
import {
	IconArrowUp,
	IconButton,
	IconCamera,
	IconImage,
	IconMic,
	IconPlus,
	IconQuestion,
	IconStop,
	Menu,
	type MenuItem,
} from "../../components/controls";
import { useGuide } from "../guide/GuideOverlay";
import { useVoiceChannel } from "../workspace/voice-context";
import { useCamera } from "./camera-context";
import { SuggestionChips } from "./SuggestionChips";

/** The field grows with the words up to this many lines, then scrolls. */
const MAX_LINES = 6;

/**
 * One line to type on, with what belongs beside it: the next steps above,
 * the add menu at the field's lead, the send at its end, the voice channel
 * and the guide at the side, and the disclosure under. Under the voice
 * pane the channel's control is the pane's, and the field says where the
 * words go. Enter sends,
 * Shift+Enter breaks a line, and a run in flight turns the send into a stop —
 * until words are typed, when it queues them to go once the answer is over.
 * Send waits while a picture is still being prepared: the runtime refuses a
 * message then, and the words would be cleared with nothing sent.
 */
export function Composer({
	value,
	onChange,
	onSubmit,
	onStop,
	isRunning,
	uploading = false,
	onAddFile,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: (text: string) => void;
	onStop?: () => void;
	isRunning: boolean;
	/** A picture waiting to go is still being prepared. */
	uploading?: boolean;
	/** The runtime's file picker, when attachments are on. */
	onAddFile?: () => void;
}) {
	const t = useTranslations("chat");
	const tAi = useTranslations("ai");
	const tVoice = useTranslations("voice");
	const openCamera = useCamera();
	const voice = useVoiceChannel();
	const guide = useGuide();
	const field = useRef<HTMLTextAreaElement>(null);

	const grow = useCallback(() => {
		const el = field.current;
		if (!el) return;
		el.style.height = "auto";
		const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 24;
		el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES)}px`;
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the words changing is what resizes the field
	useLayoutEffect(grow, [value, grow]);

	const typed = value.trim().length > 0;
	const canSend = typed && !uploading;
	const send = () => {
		const text = value.trim();
		if (!text || uploading) return;
		onSubmit(text);
		onChange("");
		field.current?.focus();
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		e.preventDefault();
		if (typed) send();
		else if (isRunning) onStop?.();
	};

	const voiceAvailable = voice?.capability.live;
	// Under the voice pane the words go into the open session; the pane has the channel's close.
	const underVoice = Boolean(voice?.open);

	const additions: MenuItem[] = [
		...(onAddFile
			? [
					{
						key: "attach",
						label: t("attach"),
						icon: <IconImage />,
						onSelect: onAddFile,
					},
				]
			: []),
		{
			key: "camera",
			label: t("camera"),
			icon: <IconCamera />,
			onSelect: openCamera,
		},
	];

	return (
		<div className="composer">
			<SuggestionChips disabled={isRunning} />
			<div className="composer-row">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: a press on the box's padding reaches the field inside it */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: the field inside is what the keyboard reaches; the box only widens the press */}
				<div
					className="composer-box"
					onClick={(e) => {
						if (e.target === e.currentTarget) field.current?.focus();
					}}
				>
					<Menu
						label={t("addMenu")}
						items={additions}
						place="above"
						align="start"
						trigger={({ props }) => (
							<IconButton
								label={t("addMenu")}
								variant="ghost"
								size="sm"
								className="composer-add"
								{...props}
							>
								<IconPlus />
							</IconButton>
						)}
					/>
					<textarea
						ref={field}
						className="composer-text"
						rows={1}
						value={value}
						placeholder={t(underVoice ? "placeholderVoice" : "placeholder")}
						aria-label={t(underVoice ? "placeholderVoice" : "placeholder")}
						onChange={(e) => onChange(e.target.value)}
						onKeyDown={onKeyDown}
					/>
					{isRunning && !typed ? (
						<IconButton
							label={t("stop")}
							variant="quiet"
							size="sm"
							className="composer-send"
							disabled={!onStop}
							onClick={onStop}
						>
							<IconStop />
						</IconButton>
					) : (
						<IconButton
							label={isRunning ? t("queue") : t("send")}
							variant="primary"
							size="sm"
							className="composer-send"
							disabled={!canSend}
							onClick={send}
						>
							<IconArrowUp />
						</IconButton>
					)}
				</div>
				<div className="composer-side">
					{voice && !underVoice ? (
						<IconButton
							label={voiceAvailable ? tVoice("start") : tVoice("unavailable")}
							data-guide="voice"
							disabled={!voiceAvailable}
							onClick={() => voice.setOpen(true)}
						>
							<IconMic />
						</IconButton>
					) : null}
					{guide ? (
						<IconButton
							label={t("guide")}
							aria-pressed={guide.showing}
							onClick={guide.open}
						>
							<IconQuestion />
						</IconButton>
					) : null}
				</div>
			</div>
			<p className="ai-line">{tAi("disclosure")}</p>
		</div>
	);
}
