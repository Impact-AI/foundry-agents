"use client";

import { useTranslations } from "next-intl";
import { useStageActions } from "./stage-actions";
import "./landing.css";

const OPENERS = ["library", "record", "chart"] as const;

/**
 * The desk — what stands on the stage when nothing has been placed: what
 * this workspace is, and three ways in, each a press that posts a turn as
 * if it had been typed. The assistant answers by putting something on the
 * stage, which is the whole demonstration.
 */
export function GuidedLanding() {
	const t = useTranslations("landing");
	const actions = useStageActions();
	return (
		<div className="panel landing card-frame">
			<div className="card-head landing-head">
				<p className="eyebrow eyebrow--accent">{t("eyebrow")}</p>
				<h1 className="landing-heading">{t("heading")}</h1>
				<p className="landing-lede">{t("lede")}</p>
			</div>
			<div className="landing-openers">
				{OPENERS.map((key, i) => (
					<button
						key={key}
						type="button"
						className="landing-opener"
						style={{ animationDelay: `${120 + i * 90}ms` }}
						onClick={() => actions.ask(t(`openers.${key}.ask`))}
					>
						<span className="landing-opener-title">
							{t(`openers.${key}.title`)}
						</span>
						<span className="landing-opener-ask">
							{t(`openers.${key}.ask`)}
						</span>
					</button>
				))}
			</div>
			<p className="landing-note">{t("note")}</p>
		</div>
	);
}
