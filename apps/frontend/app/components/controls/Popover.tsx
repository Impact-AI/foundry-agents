"use client";

import {
	type KeyboardEventHandler,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useOutsidePress } from "../use-outside-press";
import { useReturnFocus } from "../use-return-focus";

export interface PopoverTriggerProps {
	"aria-haspopup": "menu" | "dialog";
	"aria-expanded": boolean;
	onClick: () => void;
}

/**
 * A panel opened from one control and closed by the control again, a press
 * outside or Escape. Focus lands on the first element `focus` selects inside
 * it and returns to the opener when it closes. A menu is one of these with
 * menu items in it; the panel's content decides its role.
 */
export function Popover({
	label,
	role,
	place = "below",
	align = "end",
	focus = "a[href], button:not(:disabled), input, select, textarea",
	className,
	onKeyDown,
	trigger,
	children,
}: {
	/** What the panel is, for assistive technology. */
	label: string;
	role: "menu" | "dialog";
	place?: "below" | "above";
	align?: "start" | "end";
	/** The selector of what takes focus when the panel opens. */
	focus?: string;
	className?: string;
	onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
	/** The opener, handed the state and the props it must spread. */
	trigger: (state: { open: boolean; props: PopoverTriggerProps }) => ReactNode;
	/** The panel's content, handed the way to close it. */
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	useOutsidePress(root, close, open);

	return (
		<div className="menu" ref={root}>
			{trigger({
				open,
				props: {
					"aria-haspopup": role,
					"aria-expanded": open,
					onClick: () => setOpen((o) => !o),
				},
			})}
			{open ? (
				<PopoverPanel
					label={label}
					role={role}
					place={place}
					align={align}
					focus={focus}
					className={className}
					onKeyDown={onKeyDown}
				>
					{children(close)}
				</PopoverPanel>
			) : null}
		</div>
	);
}

function PopoverPanel({
	label,
	role,
	place,
	align,
	focus,
	className,
	onKeyDown,
	children,
}: {
	label: string;
	role: "menu" | "dialog";
	place: "below" | "above";
	align: "start" | "end";
	focus: string;
	className?: string;
	onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
	children: ReactNode;
}) {
	const panel = useRef<HTMLDivElement>(null);
	useReturnFocus();
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — focus moves in when the panel opens, never again
	useEffect(() => {
		panel.current?.querySelector<HTMLElement>(focus)?.focus();
	}, []);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the role is a menu or a dialog, given by the caller
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: both roles take a name
		<div
			ref={panel}
			className={[
				"menu-list",
				`menu-list--${place}`,
				`menu-list--${align}`,
				className,
			]
				.filter(Boolean)
				.join(" ")}
			role={role}
			aria-label={label}
			onKeyDown={onKeyDown}
		>
			{children}
		</div>
	);
}
