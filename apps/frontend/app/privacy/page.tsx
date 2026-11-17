import { authMode } from "@platform/identity/claims";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { conversationParam } from "@/src/workspace-href";
import { PrivacyNotice } from "./PrivacyNotice";

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations("privacy");
	return { title: t("title") };
}

export default async function PrivacyPage({
	searchParams,
}: {
	searchParams: Promise<{ c?: string }>;
}) {
	return (
		<PrivacyNotice
			conversation={conversationParam((await searchParams).c)}
			signIn={authMode()}
		/>
	);
}
