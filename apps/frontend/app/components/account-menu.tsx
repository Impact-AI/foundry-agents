import { settingsHref } from "@/src/workspace-href";
import type { MenuItem } from "./controls";
import { IconSettings, IconSignOut } from "./controls/icons";

/** Two initials from a name — "Ada Quill" → "AQ". */
export function initialsOf(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	return (
		words
			.slice(0, 2)
			.map((w) => [...w][0] ?? "")
			.join("")
			.toUpperCase() || "?"
	);
}

/**
 * The account menu, in order: the one room off the workspace, then the way
 * out. The conversations have no room: the picker in the conversation's
 * head lists, opens, renames and deletes them. Settings carries the open
 * conversation, so its way back returns to it.
 */
export function accountMenuItems({
	label,
	conversation,
	onSignOut,
}: {
	label: { settings: string; signOut: string };
	conversation: string | null;
	onSignOut: () => void;
}): MenuItem[] {
	return [
		{
			key: "settings",
			label: label.settings,
			icon: <IconSettings />,
			href: settingsHref(conversation),
		},
		{
			key: "sign-out",
			label: label.signOut,
			icon: <IconSignOut />,
			onSelect: onSignOut,
			startsGroup: true,
		},
	];
}
