import type { ReactNode } from "react";

export type StatusTone = "idle" | "live" | "busy" | "info" | "danger";

/**
 * One line that says what the screen is doing: a dot in the tone's colour
 * and the words beside it, because the dot alone is two hues a common
 * colour blindness cannot separate. Danger is announced; the rest is
 * polite. Bare, it stands in a head without a box of its own.
 */
export function StatusLine({
	tone = "idle",
	bare = false,
	strong = false,
	action,
	className,
	children,
}: {
	tone?: StatusTone;
	bare?: boolean;
	strong?: boolean;
	/** A control at the line's end: a dismiss, a way out. */
	action?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const classes = [
		"status",
		`status--${tone}`,
		bare ? "status--bare" : null,
		strong ? "status--strong" : null,
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={classes} role={tone === "danger" ? "alert" : "status"}>
			<span className="status-dot" aria-hidden="true" />
			<span className="status-text">{children}</span>
			{action ? <span className="status-action">{action}</span> : null}
		</div>
	);
}
