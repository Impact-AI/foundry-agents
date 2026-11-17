import type { ComponentProps } from "react";

export type ButtonVariant = "primary" | "quiet" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

/** The classes a button or a button-shaped link carries; a link uses this with `next/link`. */
export function buttonClass(
	variant: ButtonVariant = "quiet",
	size: ButtonSize = "md",
	className?: string,
): string {
	return ["btn", `btn--${variant}`, size === "sm" ? "btn--sm" : null, className]
		.filter(Boolean)
		.join(" ");
}

/**
 * A button with words on it. One primary per view; everything else is
 * quiet, and the ghost sits in a head where a drawn button would be noise.
 */
export function Button({
	variant = "quiet",
	size = "md",
	type = "button",
	className,
	...props
}: ComponentProps<"button"> & {
	variant?: ButtonVariant;
	size?: ButtonSize;
}) {
	return (
		<button
			type={type}
			className={buttonClass(variant, size, className)}
			{...props}
		/>
	);
}
