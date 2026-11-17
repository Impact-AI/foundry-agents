import { describe, expect, test } from "bun:test";
import { accountMenuItems, initialsOf } from "./account-menu";

describe("the account menu", () => {
	test("is Settings, then the way out — no conversations room, no second person", () => {
		let signedOut = false;
		const items = accountMenuItems({
			label: {
				settings: "Settings",
				signOut: "Sign out",
			},
			conversation: null,
			onSignOut: () => {
				signedOut = true;
			},
		});
		expect(items.map((i) => [i.label, i.href])).toEqual([
			["Settings", "/settings"],
			["Sign out", undefined],
		]);
		expect(items.filter((i) => i.startsGroup).map((i) => i.key)).toEqual([
			"sign-out",
		]);
		expect(items.some((i) => i.href === "/conversations")).toBe(false);
		items[1]?.onSelect?.();
		expect(signedOut).toBe(true);
	});

	test("Settings carries the open conversation, for its way back", () => {
		const settings = (conversation: string | null) =>
			accountMenuItems({
				label: { settings: "Settings", signOut: "Sign out" },
				conversation,
				onSignOut: () => {},
			})[0]?.href;
		expect(settings("c-42")).toBe("/settings?c=c-42");
		expect(settings(null)).toBe("/settings");
	});

	test("a disc carries two initials", () => {
		expect(initialsOf("Ada Quill")).toBe("AQ");
		expect(initialsOf("  ")).toBe("?");
	});
});
