"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { conversationParam, workspaceHref } from "@/src/workspace-href";
import { AccountButton } from "./AccountButton";
import { BrandLogo } from "./BrandLogo";
import { Button, IconBook, IconCards } from "./controls";
import { useStageControls } from "./stage-controls";
import { usePresence } from "./use-presence";
import "./top-bar.css";

/** The home mark fading out — `home-out` below. */
const HOME_EXIT_MS = 300;

/**
 * The bar: the name at the lead, the library and the records by hand and
 * the way home when a stage is up, and the account's disc at the far end.
 * No navigation — the rooms off the workspace open from the disc, and the
 * workspace is where the mark leads from anywhere else. The Library and
 * Records marks stand wherever there is a stage to put them on, so what the
 * assistant can place a person can reach without asking.
 */
export function TopBar({
	name,
	logoSrc = "",
}: {
	name: string | null;
	/** The deployment's logo, drawn before the name; empty for none. */
	logoSrc?: string;
}) {
	const t = useTranslations("workspace");
	const common = useTranslations("common");
	const pathname = usePathname();
	const onWorkspace = pathname === "/chat";
	const conversation = conversationParam(useSearchParams().get("c"));
	const stage = useStageControls();
	const home = usePresence(Boolean(stage?.stageUp), HOME_EXIT_MS);

	return (
		<header className="topbar">
			<div className="topbar-lead">
				{onWorkspace ? (
					<span className="topbar-brand">
						<BrandLogo src={logoSrc} />
						{common("appName")}
					</span>
				) : (
					<Link href={workspaceHref(conversation)} className="topbar-brand">
						<BrandLogo src={logoSrc} />
						{common("appName")}
					</Link>
				)}
				{stage ? (
					<Button
						variant="ghost"
						size="sm"
						className="topbar-library"
						onClick={stage.library}
					>
						<IconBook />
						<span className="topbar-library-label">{t("library")}</span>
					</Button>
				) : null}
				{stage ? (
					<Button
						variant="ghost"
						size="sm"
						className="topbar-library topbar-records"
						onClick={stage.records}
					>
						<IconCards />
						<span className="topbar-library-label">{t("records")}</span>
					</Button>
				) : null}
				{home.present && stage ? (
					<Button
						variant="ghost"
						size="sm"
						className={`topbar-home${home.closing ? " is-closing" : ""}`}
						onClick={stage.home}
					>
						{t("home")}
					</Button>
				) : null}
			</div>
			<AccountButton name={name} conversation={conversation} />
		</header>
	);
}
