"use client";

import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
	useTransition,
} from "react";
import type { ConversationSummary } from "@/src/backend/conversations";
import { forgetConversationImages } from "@/src/chat/image-store";
import { TITLE_LENGTH } from "@/src/chat/title";
import { errorKey } from "@/src/errors";
import { workspaceHref } from "@/src/workspace-href";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
	Button,
	IconButton,
	IconChevronDown,
	IconPencil,
	IconPlus,
	IconTrash,
	Popover,
	StatusLine,
	TextField,
} from "../../components/controls";
import { focusOnMount } from "../../components/focus-on-mount";
import {
	deleteConversation,
	listConversations,
	renameConversation,
} from "./conversation-calls";

/** The waits between reads of the list while the open conversation is being named: about half a minute in all. */
const NAMING_READS_MS = [1_500, 1_500, 2_000, 3_000, 5_000, 8_000, 10_000];

/**
 * Which conversation is open, the others to go to, and a way to a new one.
 * The URL carries the choice. The list is read again each time it opens —
 * the page's copy predates the first turn of a new conversation. Each row
 * renames in place and deletes behind the confirm dialog; deleting the open
 * one opens the newest that is left. An untitled conversation is named on
 * the server a moment after a run in it ends, so once one has, the list is
 * read again until the name is there: a fresh conversation gets its name
 * from what was said rather than a placeholder.
 */
export function ConversationPicker({
	conversations,
	current,
}: {
	conversations: ConversationSummary[];
	current: string;
}) {
	const t = useTranslations("chat");
	const tc = useTranslations("conversations");
	const common = useTranslations("common");
	const errors = useTranslations("errors");
	const router = useRouter();
	const trigger = useRef<HTMLButtonElement>(null);
	const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();
	const [listed, setListed] = useState(conversations);
	useEffect(() => setListed(conversations), [conversations]);
	const open = listed.find((c) => c.id === current);
	const title = open?.title || tc("untitled");
	const untitled = !open?.title;

	const [runsEnded, setRunsEnded] = useState(0);
	useRunEnded(useCallback(() => setRunsEnded((n) => n + 1), []));
	useEffect(() => {
		if (!runsEnded || !untitled) return;
		let live = true;
		void (async () => {
			for (const wait of NAMING_READS_MS) {
				await new Promise((resolve) => setTimeout(resolve, wait));
				if (!live) return;
				const { conversations } = await listConversations();
				if (!live) return;
				if (conversations?.some((c) => c.id === current && c.title)) {
					setListed(conversations);
					return;
				}
			}
		})();
		return () => {
			live = false;
		};
	}, [runsEnded, untitled, current]);

	return (
		<>
			<div className="chat-head card-head card-head--bar">
				<Popover
					label={tc("heading")}
					role="dialog"
					align="start"
					className="picker"
					focus="[aria-current='page'], .picker-open"
					trigger={({ props }) => (
						<button
							type="button"
							className="picker-trigger"
							ref={trigger}
							{...props}
						>
							<span className="sr-only">{t("conversationLabel")}: </span>
							<span className="picker-trigger-title">{title}</span>
							<IconChevronDown />
						</button>
					)}
				>
					{(close) => (
						<PickerList onListed={setListed}>
							{listed.length ? (
								<ul className="picker-list">
									{listed.map((c) => (
										<ConversationRow
											key={c.id}
											conversation={c}
											current={c.id === current}
											onOpen={close}
											onRenamed={(title) =>
												setListed((all) =>
													all.map((one) =>
														one.id === c.id ? { ...one, title } : one,
													),
												)
											}
											onDelete={() => {
												close();
												setDeleting(c);
											}}
										/>
									))}
								</ul>
							) : (
								<p className="picker-empty">{tc("empty")}</p>
							)}
						</PickerList>
					)}
				</Popover>
				<Button
					variant="ghost"
					size="sm"
					className="chat-head-new"
					aria-label={t("newConversationLabel")}
					title={t("newConversationLabel")}
					onClick={() => router.push(workspaceHref(crypto.randomUUID()))}
				>
					<IconPlus />
					{t("newConversation")}
				</Button>
			</div>
			{problem ? (
				<StatusLine
					tone="danger"
					action={
						<Button variant="ghost" size="sm" onClick={() => setProblem(null)}>
							{common("dismiss")}
						</Button>
					}
				>
					{problem}
				</StatusLine>
			) : null}
			{deleting ? (
				<ConfirmDialog
					heading={tc("delete")}
					body={
						<p>
							{tc("confirmDelete", {
								title: deleting.title || tc("untitled"),
							})}
						</p>
					}
					confirmLabel={common("delete")}
					cancelLabel={common("keep")}
					busy={pending}
					returnFocus={trigger}
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						const gone = deleting.id;
						startTransition(async () => {
							const result = await deleteConversation(gone);
							// What this browser kept of its pictures goes with it.
							if (!result.code) await forgetConversationImages(gone);
							setDeleting(null);
							setProblem(result.code ? errors(errorKey(result.code)) : null);
							if (result.code) return;
							if (gone === current) router.push("/chat");
							else setListed((all) => all.filter((c) => c.id !== gone));
						});
					}}
				/>
			) : null}
		</>
	);
}

/**
 * Calls `onEnded` on the falling edge of a run that answered something said
 * here: the runtime's own connect on a fresh conversation is a run too, with
 * nothing yet to name the conversation by.
 */
function useRunEnded(onEnded: () => void): void {
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
	const { isRunning } = agent;
	const was = useRef(isRunning);
	useEffect(() => {
		const said = agent.messages.some((m) => m.role === "user");
		if (was.current && !isRunning && said) onEnded();
		was.current = isRunning;
	}, [agent, isRunning, onEnded]);
}

/** Reads the list as it stands when the panel opens; until it answers, the copy the page had stands. */
function PickerList({
	onListed,
	children,
}: {
	onListed: (conversations: ConversationSummary[]) => void;
	children: ReactNode;
}) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
	useEffect(() => {
		let live = true;
		void listConversations().then(({ conversations }) => {
			if (live && conversations) onListed(conversations);
		});
		return () => {
			live = false;
		};
	}, []);
	return children;
}

/** One conversation: a way to it, its age, and its two changes — or the field that renames it. */
function ConversationRow({
	conversation,
	current,
	onOpen,
	onRenamed,
	onDelete,
}: {
	conversation: ConversationSummary;
	current: boolean;
	onOpen: () => void;
	onRenamed: (title: string) => void;
	onDelete: () => void;
}) {
	const tc = useTranslations("conversations");
	const common = useTranslations("common");
	const errors = useTranslations("errors");
	const format = useFormatter();
	const [draft, setDraft] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();
	const title = conversation.title || tc("untitled");

	if (draft !== null) {
		return (
			<li className="picker-row is-renaming">
				<form
					className="picker-rename"
					onSubmit={(e) => {
						e.preventDefault();
						const next = draft.trim();
						if (!next) return;
						startTransition(async () => {
							const result = await renameConversation(conversation.id, next);
							if (result.code) {
								setProblem(errors(errorKey(result.code)));
								return;
							}
							setDraft(null);
							onRenamed(next);
						});
					}}
				>
					<TextField
						label={tc("renameField")}
						hideLabel
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						maxLength={TITLE_LENGTH}
						error={problem}
						ref={focusOnMount}
					/>
					<div className="picker-rename-actions">
						<Button
							type="submit"
							variant="primary"
							size="sm"
							disabled={pending || !draft.trim()}
						>
							{common("save")}
						</Button>
						<Button size="sm" onClick={() => setDraft(null)}>
							{common("cancel")}
						</Button>
					</div>
				</form>
			</li>
		);
	}

	return (
		<li className="picker-row" data-current={current || undefined}>
			<Link
				href={workspaceHref(conversation.id)}
				className="picker-open"
				aria-current={current ? "page" : undefined}
				onClick={onOpen}
			>
				<span className="picker-row-title">{title}</span>
				<span className="picker-row-meta">
					{tc("updated", {
						when: format.relativeTime(
							new Date(conversation.updatedAt),
							Date.now(),
						),
					})}
				</span>
			</Link>
			<IconButton
				label={tc("renameOne", { title })}
				variant="ghost"
				size="sm"
				onClick={() => setDraft(conversation.title)}
			>
				<IconPencil />
			</IconButton>
			<IconButton
				label={tc("deleteOne", { title })}
				variant="ghost"
				size="sm"
				onClick={onDelete}
			>
				<IconTrash />
			</IconButton>
		</li>
	);
}
