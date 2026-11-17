"use client";

import {
	createContext,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useStageControls } from "../../components/stage-controls";

const GuideTour = lazy(() =>
	import("./GuideTour").then((m) => ({ default: m.GuideTour })),
);

/**
 * The guide — the workspace, explained on the workspace. A layer that dims
 * it, lights one thing at a time and says in a line what it is. It runs
 * itself on the first visit and then never again unless asked for: the `?`
 * beside the composer is the way back in. It measures live elements rather
 * than drawing a picture, so a thing not on this screen is not in the tour.
 */
export type GuideValue = {
	open: () => void;
	showing: boolean;
};

const GuideContext = createContext<GuideValue | null>(null);

export function useGuide(): GuideValue | null {
	return useContext(GuideContext);
}

/** A fact about this browser rather than about the account. */
const SEEN_KEY = "workspace.guideSeen";

/** What must be on screen before the first visit's tour runs itself. */
const READY = ".landing";
const WAIT_MS = 250;
const GIVE_UP_MS = 60_000;

export function GuideMode({ children }: { children: ReactNode }) {
	const [showing, setShowing] = useState(false);
	const controls = useStageControls();
	const stage = useRef(controls);
	stage.current = controls;

	const open = useCallback(() => {
		try {
			window.localStorage.setItem(SEEN_KEY, "1");
		} catch {
			// A reader who cannot be remembered gets the tour again next time.
		}
		// A desk tour: a stage up is sent home first.
		if (stage.current?.stageUp) stage.current.home();
		setShowing(true);
	}, []);
	const close = useCallback(() => setShowing(false), []);

	// The first visit, once the desk is on screen.
	useEffect(() => {
		let seen = true;
		try {
			seen = window.localStorage.getItem(SEEN_KEY) === "1";
		} catch {
			seen = true;
		}
		if (seen) return;
		let cancelled = false;
		const deadline = Date.now() + GIVE_UP_MS;
		const poll = () => {
			if (cancelled) return;
			if (document.querySelector(READY)) open();
			else if (Date.now() < deadline) setTimeout(poll, WAIT_MS);
		};
		const timer = setTimeout(poll, WAIT_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open]);

	const value = useMemo(() => ({ open, showing }), [open, showing]);
	return (
		<GuideContext.Provider value={value}>
			{children}
			{showing ? (
				<Suspense fallback={null}>
					<GuideTour onClose={close} />
				</Suspense>
			) : null}
		</GuideContext.Provider>
	);
}
