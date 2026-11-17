import type { ComponentProps } from "react";

export type IconButtonVariant = "quiet" | "primary" | "ghost";
export type IconButtonSize = "sm" | "md" | "lg";

/**
 * A button that is only a glyph. The label is required: it is what a
 * screen reader says and what hovering reveals, and the drawn target is
 * never smaller than the thumb.
 */
export function IconButton({
	label,
	variant = "quiet",
	size = "md",
	type = "button",
	className,
	children,
	...props
}: Omit<ComponentProps<"button">, "aria-label" | "title"> & {
	label: string;
	variant?: IconButtonVariant;
	size?: IconButtonSize;
}) {
	const classes = [
		"icon-btn",
		`icon-btn--${variant}`,
		size !== "md" ? `icon-btn--${size}` : null,
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<button
			type={type}
			className={classes}
			aria-label={label}
			title={label}
			{...props}
		>
			{children}
		</button>
	);
}
