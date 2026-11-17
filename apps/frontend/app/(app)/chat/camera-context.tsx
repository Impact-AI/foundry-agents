"use client";

import { createContext, useContext } from "react";

/**
 * How the composer reaches the camera. The composer is a module-scope slot
 * CopilotKit renders, so a prop cannot reach it; a context can.
 */
const CameraContext = createContext<() => void>(() => {});

export function CameraProvider({
	onOpen,
	children,
}: {
	onOpen: () => void;
	children: React.ReactNode;
}) {
	return (
		<CameraContext.Provider value={onOpen}>{children}</CameraContext.Provider>
	);
}

export function useCamera(): () => void {
	return useContext(CameraContext);
}
