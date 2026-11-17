"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

/**
 * The stage's controls, for the chrome that is not the workspace: the top
 * bar's home mark and the guide both need to clear the stage, the bar's
 * Library and Records marks open the library and the records by hand, and
 * none of them is a child of the workspace. The workspace registers them
 * from an effect; the chrome reads them, and null means there is no stage
 * on this screen.
 */
export interface StageControls {
	/** Clear the stage: back to the landing. */
	home: () => void;
	/** Put the library on the stage, every document — the road the tool takes. */
	library: () => void;
	/** Put the records on the stage, every one — the road the tool takes. */
	records: () => void;
	/** Whether there is something to go home from. */
	stageUp: boolean;
}

/** Exported for a render that has no workspace to register from — a test of the bar. */
export const StageControlsContext = createContext<StageControls | null>(null);
const RegisterContext = createContext<
	((controls: StageControls | null) => void) | null
>(null);

export function StageControlsProvider({ children }: { children: ReactNode }) {
	const [controls, setControls] = useState<StageControls | null>(null);
	return (
		<RegisterContext.Provider value={setControls}>
			<StageControlsContext.Provider value={controls}>
				{children}
			</StageControlsContext.Provider>
		</RegisterContext.Provider>
	);
}

export function useStageControls(): StageControls | null {
	return useContext(StageControlsContext);
}

export function useRegisterStageControls(
	home: StageControls["home"],
	library: StageControls["library"],
	records: StageControls["records"],
	stageUp: boolean,
): void {
	const register = useContext(RegisterContext);
	const controls = useMemo<StageControls>(
		() => ({ home, library, records, stageUp }),
		[home, library, records, stageUp],
	);
	useEffect(() => {
		register?.(controls);
		return () => register?.(null);
	}, [register, controls]);
}
