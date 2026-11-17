import {
	type ButtonHTMLAttributes,
	Fragment,
	type HTMLAttributes,
} from "react";
import { uniqueKeys } from "@/src/unique-keys";

/** A short thing to press: a suggestion, a related record, a page of the stage. */
export function Chip({
	on,
	type = "button",
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	/** Lit, as the one in use. */
	on?: boolean;
}) {
	return (
		<button
			type={type}
			className={["chip", className].filter(Boolean).join(" ")}
			aria-pressed={on === undefined ? undefined : on}
			{...props}
		/>
	);
}

/** A word that classifies and does nothing: a tag, a kind. */
export function Tag({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
	return (
		<span className={["tag", className].filter(Boolean).join(" ")} {...props} />
	);
}

/**
 * A row of tags. A space between each, which the flex row does not draw, so
 * the row's text is its words apart and not run together into one.
 */
export function Tags({ tags }: { tags: readonly string[] }) {
	if (!tags.length) return null;
	const keys = uniqueKeys(tags);
	return (
		<span className="tags">
			{tags.map((tag, n) => (
				<Fragment key={keys[n]}>
					{n > 0 ? " " : null}
					<Tag>{tag}</Tag>
				</Fragment>
			))}
		</span>
	);
}
