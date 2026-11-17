import type { FormEvent, ReactNode } from "react";

/**
 * A card in the one shape the token sheet spaces: the heading and what it
 * is for, the body, the actions. A card whose body is a form passes
 * `onSubmit`, and the form spans the body and the actions without becoming
 * a box of its own.
 */
export function Card({
	id,
	heading,
	description,
	actions,
	split = false,
	onSubmit,
	className,
	children,
}: {
	/** The heading's id: the card is named by it, and a group inside may be too. */
	id: string;
	heading: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	/** Actions at both ends rather than all at the end. */
	split?: boolean;
	onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
	className?: string;
	children?: ReactNode;
}) {
	const content = (
		<>
			{children ? <div className="card-body">{children}</div> : null}
			{actions ? (
				<div className={`card-actions${split ? " card-actions--split" : ""}`}>
					{actions}
				</div>
			) : null}
		</>
	);
	return (
		<section
			className={["card", className].filter(Boolean).join(" ")}
			aria-labelledby={id}
		>
			<header className="card-head">
				<h2 id={id}>{heading}</h2>
				{description ? <p className="card-desc">{description}</p> : null}
			</header>
			{onSubmit ? (
				<form className="card-form" onSubmit={onSubmit}>
					{content}
				</form>
			) : (
				content
			)}
		</section>
	);
}
