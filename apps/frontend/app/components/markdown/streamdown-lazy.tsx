"use client";

import { type ComponentProps, useEffect, useState } from "react";
import { reportLoadFailure } from "../Vitals";

/**
 * `streamdown`, behind `import()`. It statically carries KaTeX and a code
 * highlighter that no first screen renders, so every markdown surface asks
 * for it here, at the moment it draws: CopilotKit's assistant message, which
 * imports the bare specifier that `next.config.ts` aliases to this file, and
 * `Markdown`. The real module is reached by its path in the repository's
 * `node_modules`, because the alias applies to every bare `streamdown` in
 * the graph, this file's included.
 *
 * While the chunk is on the wire the text is shown plain rather than as a
 * hole; once the module has landed, later renders never flash plain.
 */
export type StreamdownModule =
	typeof import("../../../../../node_modules/streamdown");
type StreamdownProps = ComponentProps<StreamdownModule["Streamdown"]>;

let landed: StreamdownModule | null = null;

export function loadStreamdown(): Promise<StreamdownModule> {
	return import("../../../../../node_modules/streamdown").then((module) => {
		landed = module;
		return module;
	});
}

/**
 * The module, or null until it is here. The server has no chunk to wait for
 * and the client's first render must match it, so both start from what has
 * already landed.
 */
export function useStreamdown(): StreamdownModule | null {
	const [module, setModule] = useState(landed);
	useEffect(() => {
		if (module) return;
		let cancelled = false;
		loadStreamdown().then(
			(loaded) => {
				if (!cancelled) setModule(loaded);
			},
			() => reportLoadFailure("markdown renderer"),
		);
		return () => {
			cancelled = true;
		};
	}, [module]);
	return module;
}

export function PlainText({
	children,
	className,
}: {
	children?: string;
	className?: string;
}) {
	return (
		<div className={className} style={{ whiteSpace: "pre-wrap" }}>
			{children}
		</div>
	);
}

export function Streamdown(props: StreamdownProps) {
	const module = useStreamdown();
	if (!module)
		return <PlainText className={props.className}>{props.children}</PlainText>;
	return <module.Streamdown {...props} />;
}
