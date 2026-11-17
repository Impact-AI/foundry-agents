"use client";

import {
	type ReactNode,
	type RefObject,
	useId,
	useLayoutEffect,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import { useOutsidePress } from "../use-outside-press";
import { useReturnFocus } from "../use-return-focus";

const FOCUSABLE =
	"a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * Make everything beside the sheet inert — out of reach of Tab, a press and
 * assistive technology — and answer how to give it back. Only what this
 * sheet made inert is released, so an element inert for its own reasons
 * stays so.
 */
export function holdBeside(
	sheet: Element,
	siblings: Iterable<Element & { inert: boolean }>,
): () => void {
	const held = [...siblings].filter((el) => el !== sheet && !el.inert);
	for (const el of held) el.inert = true;
	return () => {
		for (const el of held) el.inert = false;
	};
}

/**
 * A sheet over the page. Focus moves into it as it opens — onto whatever a
 * caller already focused there, else its first control — and returns to
 * what opened it (or `returnFocus`, when the opener went with the thing
 * that opened the sheet) when it closes. While it is up the rest of the page
 * is inert, so Tab cannot leave it and nothing behind it can take focus. A
 * press outside or Escape closes it unless it is busy, and the page under
 * it is held still (`globals.css`). The heading names it for assistive
 * technology; a dialog with no heading names itself with `label`. It is
 * drawn at the body, so a panel's blur, which would make it the sheet's
 * containing block, never shrinks it to the panel; with no document (a
 * server render) it is drawn in place.
 *
 * Not the native `<dialog>`: its UA box (display, size, margin, the
 * `::backdrop`) would restyle the sheet and its entrance, and the browser's
 * close-request handling closes a modal on a second Escape whatever the
 * page says — a busy sheet would vanish while the thing it is doing runs on.
 */
export function Dialog({
	heading,
	label,
	role = "dialog",
	busy = false,
	onClose,
	returnFocus,
	actions,
	className,
	children,
}: {
	heading?: ReactNode;
	label?: string;
	role?: "dialog" | "alertdialog";
	/** While busy the sheet cannot be dismissed: the thing it is doing has to finish. */
	busy?: boolean;
	onClose: () => void;
	/** Where focus goes on close when the opener is no longer on the page. */
	returnFocus?: RefObject<HTMLElement | null>;
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const backdrop = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const headingId = useId();
	useReturnFocus(returnFocus);
	useOutsidePress(panel, onClose, !busy);
	useLayoutEffect(() => {
		const sheet = backdrop.current;
		const box = panel.current;
		if (!sheet || !box) return;
		const release = holdBeside(
			sheet,
			[...document.body.children].filter(
				(el): el is HTMLElement => el instanceof HTMLElement,
			),
		);
		if (!box.contains(document.activeElement))
			(box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();
		return release;
	}, []);
	const sheet = (
		<div className="dialog-backdrop" ref={backdrop}>
			{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is one of the two dialog roles, and both take aria-modal and a name */}
			<div
				ref={panel}
				className={["dialog card-frame", className].filter(Boolean).join(" ")}
				role={role}
				aria-modal="true"
				aria-labelledby={heading ? headingId : undefined}
				aria-label={heading ? undefined : label}
				tabIndex={-1}
			>
				{heading ? <h2 id={headingId}>{heading}</h2> : null}
				<div className="card-body">{children}</div>
				{actions ? <div className="card-actions">{actions}</div> : null}
			</div>
		</div>
	);
	return typeof document === "undefined"
		? sheet
		: createPortal(sheet, document.body);
}
