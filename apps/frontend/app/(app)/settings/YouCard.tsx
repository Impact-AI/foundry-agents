"use client";

import type { AuthMode } from "@platform/identity/claims";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { errorKey } from "@/src/errors";
import {
	changesOf,
	draftOf,
	isSavable,
	PERSON_NAME_MAX,
	PERSON_TEXT_MAX,
	type Person,
	type PersonDraft,
} from "@/src/person";
import {
	Button,
	Card,
	StatusLine,
	TextArea,
	TextField,
} from "../../components/controls";
import { savePerson } from "./person-calls";

/**
 * Who the person is, as the assistant reads it on every turn: their name,
 * what they wrote about themselves, how they want to be talked to. The
 * fields are the form; Save and Cancel appear only once one has changed.
 * `signIn` is the deployment's sign-in mode: the provider fills the name at
 * the first sign-in, and the field says so.
 */
export function YouCard({
	person,
	signIn,
}: {
	person: Person;
	signIn: AuthMode;
}) {
	const router = useRouter();
	const errors = useTranslations("errors");
	const [saved, setSaved] = useState(() => draftOf(person));
	const [draft, setDraft] = useState(saved);
	const [problem, setProblem] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const save = () => {
		const patch = changesOf(saved, draft);
		if (!patch) return;
		startTransition(async () => {
			const result = await savePerson(patch);
			if (!result.person) {
				setProblem(errors(errorKey(result.code ?? "generic")));
				return;
			}
			const next = draftOf(result.person);
			setSaved(next);
			setDraft(next);
			setProblem(null);
			// The bar's disc carries the name.
			router.refresh();
		});
	};

	return (
		<YouFields
			saved={saved}
			draft={draft}
			signIn={signIn}
			busy={pending}
			problem={problem}
			onChange={(change) => setDraft((d) => ({ ...d, ...change }))}
			onSave={save}
			onCancel={() => {
				setDraft(saved);
				setProblem(null);
			}}
		/>
	);
}

/** The card itself, drawn from a draft and what was saved. */
export function YouFields({
	saved,
	draft,
	signIn,
	busy = false,
	problem = null,
	onChange,
	onSave,
	onCancel,
}: {
	saved: PersonDraft;
	draft: PersonDraft;
	signIn: AuthMode;
	busy?: boolean;
	problem?: string | null;
	onChange: (change: Partial<PersonDraft>) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	const t = useTranslations("settings.you");
	const dirty = changesOf(saved, draft) !== null;
	return (
		<Card
			id="you-heading"
			heading={t("heading")}
			description={t("lede")}
			onSubmit={(e) => {
				e.preventDefault();
				if (dirty && isSavable(draft)) onSave();
			}}
			actions={
				dirty ? (
					<>
						<Button disabled={busy} onClick={onCancel}>
							{t("cancel")}
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={busy || !isSavable(draft)}
						>
							{busy ? t("saving") : t("save")}
						</Button>
					</>
				) : null
			}
		>
			<TextField
				label={t("name")}
				name="name"
				autoComplete="nickname"
				maxLength={PERSON_NAME_MAX}
				value={draft.name}
				onChange={(e) => onChange({ name: e.target.value })}
				placeholder={t("namePlaceholder")}
				hint={signIn === "entra" ? t("nameHint") : null}
				error={dirty && !draft.name.trim() ? t("nameRequired") : null}
			/>
			<TextArea
				label={t("about")}
				name="about"
				maxLength={PERSON_TEXT_MAX}
				value={draft.about}
				onChange={(e) => onChange({ about: e.target.value })}
				placeholder={t("aboutPlaceholder")}
				hint={t("aboutHint")}
			/>
			<TextArea
				label={t("preferences")}
				name="preferences"
				maxLength={PERSON_TEXT_MAX}
				value={draft.preferences}
				onChange={(e) => onChange({ preferences: e.target.value })}
				placeholder={t("preferencesPlaceholder")}
				hint={t("preferencesHint")}
			/>
			{problem ? <StatusLine tone="danger">{problem}</StatusLine> : null}
		</Card>
	);
}
