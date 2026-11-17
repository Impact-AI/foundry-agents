"use client";

import { useTranslations } from "next-intl";
import { accountMenuItems, initialsOf } from "./account-menu";
import { Menu } from "./controls";
import { signOutHere } from "./sign-out";

/**
 * The disc at the bar's end — the one place every app keeps the account.
 * There is no navigation elsewhere: the rooms off the workspace open from
 * the menu this raises, and so does the way out.
 */
export function AccountButton({
	name,
	conversation,
}: {
	name: string | null;
	/** The conversation open on the workspace, when its URL names one. */
	conversation: string | null;
}) {
	const t = useTranslations("menu");
	const common = useTranslations("common");
	const label = name ? t("accountOf", { name }) : t("account");
	const initials = name ? initialsOf(name) : null;
	// The disc shows initials, and a name that does not hold what is shown
	// fails WCAG 2.5.3 (Label in Name): speech input says "LS", not the
	// person's name. So the name starts with them.
	const discName = initials ? `${initials}, ${label}` : label;
	const items = accountMenuItems({
		label: {
			settings: t("settings"),
			signOut: common("signOut"),
		},
		conversation,
		onSignOut: () => void signOutHere("out"),
	});
	return (
		<Menu
			label={label}
			head={name ?? t("account")}
			items={items}
			trigger={({ props }) => (
				<button
					type="button"
					className="account-disc"
					aria-label={discName}
					title={label}
					{...props}
				>
					<span aria-hidden="true">{initials ?? "·"}</span>
				</button>
			)}
		/>
	);
}
