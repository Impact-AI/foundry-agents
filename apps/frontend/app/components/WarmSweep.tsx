"use client";

import { useEffect } from "react";
import { warmPanelsWhenIdle } from "./warm-panels";

/** The longest beat in the app, so every nearer warm outranks it. */
const SWEEP_AFTER_MS = 9000;

/** Renders nothing; starts the start-of-session sweep from a quiet moment. */
export function WarmSweep() {
	useEffect(() => warmPanelsWhenIdle(SWEEP_AFTER_MS), []);
	return null;
}
