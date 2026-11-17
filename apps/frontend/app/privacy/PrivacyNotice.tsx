import type { AuthMode } from "@platform/identity/claims";
import { useTranslations } from "next-intl";
import { BackToChat } from "../components/BackToChat";
import { Card } from "../components/controls";

/**
 * The plain-words notice. Every claim in it is a transparency obligation: a
 * field this app or the backend starts keeping is a change here, in every
 * catalogue, in the same pass. `conversation` is the one it was opened from;
 * `signIn` decides the line only a demo sign-in makes true — that nobody can
 * come back to such an account, so nobody can erase it afterwards either.
 */
export function PrivacyNotice({
	conversation,
	signIn,
}: {
	conversation: string | null;
	signIn: AuthMode;
}) {
	const t = useTranslations("privacy");
	return (
		<main className="page privacy-doc">
			<div className="page-head">
				<BackToChat conversation={conversation} />
				<h1>{t("title")}</h1>
				<p className="note">{t("updated")}</p>
				<p className="lede">{t("lede")}</p>
			</div>

			<Card id="privacy-controller" heading={t("controller.heading")}>
				<p>{t("controller.body")}</p>
			</Card>

			<Card id="privacy-kept" heading={t("kept.heading")}>
				<ul>
					<li>{t("kept.account")}</li>
					<li>{t("kept.you")}</li>
					<li>{t("kept.conversations")}</li>
					<li>{t("kept.memory")}</li>
					<li>{t("kept.pictures")}</li>
					<li>{t("kept.web")}</li>
					<li>{t("kept.voice")}</li>
					<li>{t("kept.logs")}</li>
				</ul>
			</Card>

			<Card id="privacy-model" heading={t("model.heading")}>
				<p>{t("model.body")}</p>
			</Card>

			<Card id="privacy-why" heading={t("why.heading")}>
				<p>{t("why.body")}</p>
			</Card>

			<Card id="privacy-how-long" heading={t("howLong.heading")}>
				<p>{t("howLong.body")}</p>
				{signIn === "local" ? <p>{t("howLong.local")}</p> : null}
			</Card>

			<Card id="privacy-rights" heading={t("rights.heading")}>
				<p>{t("rights.body")}</p>
				<ul>
					<li>{t("rights.export")}</li>
					<li>{t("rights.correct")}</li>
					<li>{t("rights.delete")}</li>
				</ul>
			</Card>

			<Card id="privacy-cookies" heading={t("cookies.heading")}>
				<p>{t("cookies.body")}</p>
			</Card>

			<Card id="privacy-ai" heading={t("ai.heading")}>
				<p>{t("ai.body")}</p>
			</Card>
		</main>
	);
}
