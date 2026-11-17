"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocale } from "@/src/i18n/actions";
import { locales } from "@/src/i18n/locales";
import { SelectField } from "./controls";

export function LanguageSelect({
	hint,
	hideLabel,
}: {
	hint?: string;
	/** When a heading above already says "Language", the label is for a screen reader alone. */
	hideLabel?: boolean;
}) {
	const current = useLocale();
	const t = useTranslations("language");
	const [pending, startTransition] = useTransition();
	return (
		<SelectField
			label={t("label")}
			hideLabel={hideLabel}
			hint={hint}
			value={current}
			disabled={pending}
			onChange={(e) => {
				const next = e.target.value;
				startTransition(() => setLocale(next));
			}}
		>
			{locales.codes.map((code) => (
				<option key={code} value={code}>
					{locales.label(code)}
				</option>
			))}
		</SelectField>
	);
}
