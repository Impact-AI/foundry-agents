import { authMode } from "@platform/identity/claims";
import { getTranslations } from "next-intl/server";
import { readVoiceTuning } from "@/src/backend/voice";
import { readAccountView, requireCaller } from "@/src/session";
import { getTextScale } from "@/src/text-scale-store";
import { conversationParam, privacyHref } from "@/src/workspace-href";
import { BackToChat } from "../../components/BackToChat";
import { Card, StatusLine } from "../../components/controls";
import { LanguageSelect } from "../../components/LanguageSelect";
import { TextSizeSelect } from "../../components/TextSizeSelect";
import { AccountActions } from "./AccountActions";
import { MemoryCard } from "./MemoryCard";
import { readSettings } from "./reads";
import { VoiceTuningCard } from "./VoiceTuningCard";
import { YouCard } from "./YouCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The person first — who they are to the assistant, and what it remembers
 * about them — then the app's own settings (and, for a voice tester, the
 * voice tuning), then the account and the rights over what it holds. `c` is the conversation Settings was opened from.
 */
export default async function SettingsPage({
	searchParams,
}: {
	searchParams: Promise<{ c?: string }>;
}) {
	const caller = await requireCaller();
	const conversation = conversationParam((await searchParams).c);
	const [account, read, textScale, tuning, t] = await Promise.all([
		readAccountView(),
		readSettings(caller),
		getTextScale(),
		// Drawn for a voice tester alone, as the backend decides from the account's row; a backend that cannot say draws none.
		readVoiceTuning(caller).catch(() => null),
		getTranslations("settings"),
	]);
	const head = (
		<div className="page-head">
			<BackToChat conversation={conversation} />
			<h1>{t("heading")}</h1>
			<p className="lede">{t("lede")}</p>
		</div>
	);
	// An erase this session asked for and that stopped part way, or one that finished: asking again finishes it and signs out.
	if (!read)
		return (
			<div className="page">
				{head}
				<Card id="data-heading" heading={t("dataHeading")}>
					<StatusLine tone="danger">{t("eraseUnfinished")}</StatusLine>
					<AccountActions />
				</Card>
			</div>
		);
	const { person, remembered } = read;
	// The shell's layout draws the page's main landmark.
	return (
		<div className="page">
			{head}
			<YouCard person={person} signIn={authMode()} />
			<MemoryCard remembered={remembered.items} />
			<Card id="language-heading" heading={t("languageHeading")}>
				<LanguageSelect hint={t("languageHint")} hideLabel />
			</Card>
			<Card id="text-size-heading" heading={t("textHeading")}>
				<TextSizeSelect labelledBy="text-size-heading" initial={textScale} />
			</Card>
			{tuning ? <VoiceTuningCard initial={tuning} /> : null}
			<Card id="account-heading" heading={t("accountHeading")}>
				<dl className="facts">
					<dt>{t("emailLabel")}</dt>
					<dd>{account?.email ?? "—"}</dd>
					<dt>{t("tierLabel")}</dt>
					<dd>{t(`tiers.${account?.tier ?? "base"}`)}</dd>
				</dl>
				<p className="hint">{t("tierHint")}</p>
			</Card>
			<Card
				id="data-heading"
				heading={t("dataHeading")}
				description={
					<>
						{t("dataHint")}{" "}
						<a href={privacyHref(conversation)}>{t("privacyLink")}</a>
					</>
				}
			>
				<AccountActions />
			</Card>
		</div>
	);
}
