import type { ComponentProps, ReactNode } from "react";
import { useId } from "react";

interface FieldChrome {
	label: ReactNode;
	/** Read under the control; tied to it for assistive technology. */
	hint?: ReactNode;
	/** Read under the control in the danger colour, and announced. */
	error?: ReactNode;
	/** The label stays for a screen reader and leaves the screen. */
	hideLabel?: boolean;
	className?: string;
}

function Chrome({
	id,
	label,
	hint,
	error,
	hideLabel,
	className,
	children,
}: FieldChrome & { id: string; children: ReactNode }) {
	return (
		<div className={["form-field", className].filter(Boolean).join(" ")}>
			<label htmlFor={id} className={hideLabel ? "sr-only" : "form-label"}>
				{label}
			</label>
			{children}
			{hint ? (
				<span id={`${id}-hint`} className="form-hint">
					{hint}
				</span>
			) : null}
			{error ? (
				<span id={`${id}-error`} className="form-error" role="alert">
					{error}
				</span>
			) : null}
		</div>
	);
}

/** What the control itself carries: what is read with it, and whether it is in error. */
function described(id: string, hint?: ReactNode, error?: ReactNode) {
	const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
		.filter(Boolean)
		.join(" ");
	return {
		"aria-describedby": ids || undefined,
		"aria-invalid": error ? ("true" as const) : undefined,
	};
}

/** One line of text. */
export function TextField({
	label,
	hint,
	error,
	hideLabel,
	className,
	id: given,
	...props
}: FieldChrome & Omit<ComponentProps<"input">, "className">) {
	const own = useId();
	const id = given ?? own;
	return (
		<Chrome {...{ id, label, hint, error, hideLabel, className }}>
			<input
				id={id}
				className="form-input"
				{...described(id, hint, error)}
				{...props}
			/>
		</Chrome>
	);
}

/** Several lines of text. */
export function TextArea({
	label,
	hint,
	error,
	hideLabel,
	className,
	id: given,
	...props
}: FieldChrome & Omit<ComponentProps<"textarea">, "className">) {
	const own = useId();
	const id = given ?? own;
	return (
		<Chrome {...{ id, label, hint, error, hideLabel, className }}>
			<textarea
				id={id}
				className="form-input"
				{...described(id, hint, error)}
				{...props}
			/>
		</Chrome>
	);
}

/** One of a list. */
export function SelectField({
	label,
	hint,
	error,
	hideLabel,
	className,
	id: given,
	children,
	...props
}: FieldChrome & Omit<ComponentProps<"select">, "className">) {
	const own = useId();
	const id = given ?? own;
	return (
		<Chrome {...{ id, label, hint, error, hideLabel, className }}>
			<select
				id={id}
				className="form-input"
				{...described(id, hint, error)}
				{...props}
			>
				{children}
			</select>
		</Chrome>
	);
}
