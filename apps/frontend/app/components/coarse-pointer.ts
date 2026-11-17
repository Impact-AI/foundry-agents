"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the reader is holding a phone — the primary pointer's precision,
 * which decides what a hint says ("click" or "tap") and whether Enter sends.
 * `useSyncExternalStore` so the server and the first client paint agree.
 */
const COARSE = "(pointer: coarse)";

const subscribe = (onChange: () => void) => {
	const query = window.matchMedia(COARSE);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
};
const read = () => window.matchMedia(COARSE).matches;
const serverRead = () => false;

export function useCoarsePointer(): boolean {
	return useSyncExternalStore(subscribe, read, serverRead);
}
