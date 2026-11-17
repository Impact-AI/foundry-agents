"use client";

import type { RefObject } from "react";
import { Button, Dialog } from "./controls";
import { focusOnMount } from "./focus-on-mount";

/** A yes/no question over the page: focus lands on the safe answer, a press outside says no. */
export function ConfirmDialog({
	heading,
	body,
	confirmLabel,
	cancelLabel,
	busy = false,
	danger = true,
	onConfirm,
	onCancel,
	returnFocus,
}: {
	heading: string;
	body: React.ReactNode;
	confirmLabel: string;
	cancelLabel: string;
	busy?: boolean;
	danger?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	/** Where focus goes on close when the opener is no longer on the page. */
	returnFocus?: RefObject<HTMLElement | null>;
}) {
	return (
		<Dialog
			role="alertdialog"
			heading={heading}
			busy={busy}
			onClose={onCancel}
			returnFocus={returnFocus}
			actions={
				<>
					<Button disabled={busy} onClick={onCancel} ref={focusOnMount}>
						{cancelLabel}
					</Button>
					<Button
						variant={danger ? "danger" : "primary"}
						disabled={busy}
						onClick={onConfirm}
					>
						{confirmLabel}
					</Button>
				</>
			}
		>
			{body}
		</Dialog>
	);
}
