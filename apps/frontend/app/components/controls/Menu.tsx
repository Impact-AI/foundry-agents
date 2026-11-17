"use client";

import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";
import { Popover, type PopoverTriggerProps } from "./Popover";

export interface MenuItem {
	key: string;
	label: string;
	icon?: ReactNode;
	/** A room to go to; otherwise the item does something here. */
	href?: string;
	onSelect?: () => void;
	/** A rule is drawn above it: the item starts a group of its own. */
	startsGroup?: boolean;
}

/** The arrows walk the items, round from either end. */
function walk(e: KeyboardEvent<HTMLDivElement>) {
	if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
	e.preventDefault();
	const items = Array.from(
		e.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
	);
	const at = items.indexOf(document.activeElement as HTMLElement);
	const step = e.key === "ArrowDown" ? 1 : -1;
	items[(at + step + items.length) % items.length]?.focus();
}

/**
 * A list of things to do, opened from one control and closed by a choice,
 * a press outside or Escape. The arrows walk it, focus lands on the first
 * item and returns to the opener; every item is a real button or link.
 */
export function Menu({
	label,
	head,
	items,
	place = "below",
	align = "end",
	trigger,
}: {
	/** What the list is, for assistive technology. */
	label: string;
	/** A line above the items that says whose menu this is. */
	head?: ReactNode;
	items: readonly MenuItem[];
	place?: "below" | "above";
	align?: "start" | "end";
	/** The opener, handed the state and the props it must spread. */
	trigger: (state: { open: boolean; props: PopoverTriggerProps }) => ReactNode;
}) {
	return (
		<Popover
			label={label}
			role="menu"
			place={place}
			align={align}
			focus="[role='menuitem']"
			onKeyDown={walk}
			trigger={trigger}
		>
			{(close) => (
				<>
					{head ? <div className="menu-head">{head}</div> : null}
					{items.map((item) => (
						<MenuEntry key={item.key} item={item} onClose={close} />
					))}
				</>
			)}
		</Popover>
	);
}

function MenuEntry({ item, onClose }: { item: MenuItem; onClose: () => void }) {
	const body = (
		<>
			{item.icon}
			<span>{item.label}</span>
		</>
	);
	return (
		<>
			{item.startsGroup ? <hr className="menu-rule" /> : null}
			{item.href ? (
				<Link
					href={item.href}
					role="menuitem"
					className="menu-item"
					onClick={onClose}
				>
					{body}
				</Link>
			) : (
				<button
					type="button"
					role="menuitem"
					className="menu-item"
					onClick={() => {
						onClose();
						item.onSelect?.();
					}}
				>
					{body}
				</button>
			)}
		</>
	);
}
