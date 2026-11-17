import Link from "next/link";
import { useTranslations } from "next-intl";
import { workspaceHref } from "@/src/workspace-href";
import { buttonClass, IconChevronLeft } from "./controls";

/**
 * The way back from a room off the workspace, at the lead of its head: to
 * the conversation the room was opened from, or the newest. A link, so the
 * browser's own Back keeps its history. On a phone the words leave the
 * screen and stay its name.
 */
export function BackToChat({ conversation }: { conversation: string | null }) {
	const t = useTranslations("common");
	return (
		<Link
			href={workspaceHref(conversation)}
			className={buttonClass("ghost", "sm", "back-to-chat")}
		>
			<IconChevronLeft />
			<span className="back-to-chat-label">{t("backToChat")}</span>
		</Link>
	);
}
