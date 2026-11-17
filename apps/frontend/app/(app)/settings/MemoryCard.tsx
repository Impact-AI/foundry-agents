"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { errorKey } from "@/src/errors";
import { MEMORY_ITEM_MAX, type RememberedItem } from "@/src/person";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Button, Card, StatusLine, TextArea } from "../../components/controls";
import { focusOnMount } from "../../components/focus-on-mount";
import {
	editing,
	isEditSavable,
	type MemoryEditing,
	reading,
	removeItem,
	saveDraft,
} from "./memory-editing";
import { forgetMemory } from "./person-calls";

/**
 * What the assistant remembers about the person: short statements the
 * assistant keeps from their conversations, each with when it was last
 * written, each theirs to correct or remove, and all of it to forget behind
 * the confirm dialog, because nothing brings it back but more conversation.
 */
export function MemoryCard({ remembered }: { remembered: RememberedItem[] }) {
	const errors = useTranslations("errors");
	const [state, setState] = useState(() => reading(remembered));
	const [confirming, setConfirming] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const show = (next: MemoryEditing, code?: string) => {
		setState(next);
		setProblem(code ? errors(errorKey(code)) : null);
	};
	const call = (work: () => Promise<{ state: MemoryEditing; code?: string }>) =>
		startTransition(async () => {
			const result = await work();
			show(result.state, result.code);
		});

	return (
		<MemoryView
			state={state}
			busy={pending}
			problem={problem}
			confirming={confirming}
			onEdit={(id) => show(editing(state, id))}
			onChange={(draft) =>
				state.editing &&
				setState({ ...state, editing: { ...state.editing, draft } })
			}
			onCancel={() => show(reading(state.items))}
			onSave={() => call(() => saveDraft(state))}
			onRemove={(id) => call(() => removeItem(state, id))}
			onForget={() => setConfirming(true)}
			onForgetCancel={() => setConfirming(false)}
			onForgetConfirm={() =>
				startTransition(async () => {
					const result = await forgetMemory();
					setConfirming(false);
					show(result.code ? state : reading([]), result.code);
				})
			}
		/>
	);
}

/**
 * The card itself: the statements, each with Edit and Remove; the one being
 * corrected as a field with Cancel and a Save that waits for a change; and
 * Forget all of it under the list.
 */
export function MemoryView({
	state,
	busy = false,
	problem = null,
	confirming = false,
	onEdit,
	onChange,
	onSave,
	onCancel,
	onRemove,
	onForget,
	onForgetCancel,
	onForgetConfirm,
}: {
	state: MemoryEditing;
	busy?: boolean;
	problem?: string | null;
	confirming?: boolean;
	onEdit: (id: string) => void;
	onChange: (draft: string) => void;
	onSave: () => void;
	onCancel: () => void;
	onRemove: (id: string) => void;
	onForget: () => void;
	onForgetCancel: () => void;
	onForgetConfirm: () => void;
}) {
	const t = useTranslations("settings.memory");
	const format = useFormatter();
	const head = {
		id: "memory-heading",
		heading: t("heading"),
		description: t("how"),
	};
	if (state.items.length === 0)
		return (
			<Card {...head}>
				<p className="note">{t("empty")}</p>
				{problem ? <StatusLine tone="danger">{problem}</StatusLine> : null}
			</Card>
		);
	return (
		<Card
			{...head}
			actions={
				<Button variant="danger" disabled={busy} onClick={onForget}>
					{t("forget")}
				</Button>
			}
		>
			<ul className="memory-list">
				{state.items.map((item) =>
					state.editing?.id === item.id ? (
						<li key={item.id}>
							<form
								className="memory-edit"
								onSubmit={(e) => {
									e.preventDefault();
									if (isEditSavable(state)) onSave();
								}}
							>
								<TextArea
									label={t("label")}
									hideLabel
									name="memory"
									value={state.editing.draft}
									maxLength={MEMORY_ITEM_MAX}
									onChange={(e) => onChange(e.target.value)}
									rows={3}
									ref={focusOnMount}
								/>
								<span className="row">
									<Button disabled={busy} onClick={onCancel}>
										{t("cancel")}
									</Button>
									<Button
										type="submit"
										variant="primary"
										disabled={busy || !isEditSavable(state)}
									>
										{busy ? t("saving") : t("save")}
									</Button>
								</span>
							</form>
						</li>
					) : (
						<li key={item.id}>
							<p>{item.content}</p>
							<span className="note">
								{t("updated", {
									date: format.dateTime(new Date(item.updatedAt), {
										dateStyle: "medium",
									}),
								})}
							</span>
							<span className="row">
								<Button
									disabled={busy || state.editing !== null}
									onClick={() => onEdit(item.id)}
									aria-label={t("editOne", { statement: item.content })}
								>
									{t("edit")}
								</Button>
								<Button
									disabled={busy || state.editing !== null}
									onClick={() => onRemove(item.id)}
									aria-label={t("removeOne", { statement: item.content })}
								>
									{t("remove")}
								</Button>
							</span>
						</li>
					),
				)}
			</ul>
			{problem ? <StatusLine tone="danger">{problem}</StatusLine> : null}
			{confirming ? (
				<ConfirmDialog
					heading={t("forgetHeading")}
					body={<p>{t("forgetBody")}</p>}
					confirmLabel={busy ? t("forgetting") : t("forgetConfirm")}
					cancelLabel={t("forgetCancel")}
					busy={busy}
					onCancel={onForgetCancel}
					onConfirm={onForgetConfirm}
				/>
			) : null}
		</Card>
	);
}
