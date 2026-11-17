"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
	TEXT_SCALE_NAMES,
	TEXT_SCALES,
	type TextScale,
} from "@/src/text-scale";
import { chooseTextScale } from "@/src/text-scale-actions";

/**
 * The rungs as one radio group, named by the heading above it. The page
 * hands in the scale its cookie names, so the server's markup and the
 * browser's first render agree on which rung is on.
 */
export function TextSizeSelect({
	labelledBy,
	initial,
}: {
	labelledBy: string;
	initial: TextScale;
}) {
	const t = useTranslations("settings");
	const [pending, startTransition] = useTransition();
	const [scale, setScale] = useState<TextScale>(initial);

	const choose = (next: TextScale) => {
		setScale(next);
		// Applied to the document at once; the cookie makes it outlive the page.
		document.documentElement.dataset.textScale = String(next);
		startTransition(() => chooseTextScale(next));
	};

	return (
		<div className="form-field">
			<div
				className="text-size-steps"
				role="radiogroup"
				aria-labelledby={labelledBy}
				aria-busy={pending}
			>
				{TEXT_SCALES.map((rung) => (
					<label
						key={rung}
						className="text-size-step"
						data-scale={rung}
						data-on={rung === scale ? "" : undefined}
					>
						<input
							type="radio"
							name="text-scale"
							className="sr-only"
							value={rung}
							checked={rung === scale}
							onChange={() => choose(rung)}
						/>
						<span className="text-size-step-a" aria-hidden="true">
							A
						</span>
						<span className="text-size-step-name">
							{t(`textSizes.${TEXT_SCALE_NAMES[rung]}`)}
						</span>
					</label>
				))}
			</div>
			<p className="form-hint">{t("textHint")}</p>
		</div>
	);
}
