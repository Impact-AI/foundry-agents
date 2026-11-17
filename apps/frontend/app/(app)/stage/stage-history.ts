"use client";

import { useEffect, useRef } from "react";

/**
 * The stage, as somewhere the browser's Back button can come back from.
 * The workspace never navigates, so when the stage comes up one entry of
 * the workspace's own is pushed; when Back pops it the stage is cleared instead of the
 * reader leaving. A close from inside spends the entry too, and the pop it
 * causes is ignored. The state passed is a plain object: Next skips its
 * URL sync when handed its own marker back.
 */
const MARK = "stage";

export function useStageHistory(stageUp: boolean, home: () => void): void {
	const homeRef = useRef(home);
	homeRef.current = home;
	const marked = useRef(false);
	const unwinding = useRef(false);

	useEffect(() => {
		if (stageUp === marked.current) return;
		if (stageUp) {
			marked.current = true;
			window.history.pushState({ [MARK]: true }, "", window.location.href);
			return;
		}
		marked.current = false;
		unwinding.current = true;
		window.history.back();
	}, [stageUp]);

	useEffect(() => {
		function onPop() {
			if (unwinding.current) {
				unwinding.current = false;
				return;
			}
			if (!marked.current) return;
			marked.current = false;
			homeRef.current();
		}
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);
}
