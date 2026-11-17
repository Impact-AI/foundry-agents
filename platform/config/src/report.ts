import { processSingleton } from "./singleton";

/**
 * The one shape of a failure line: `[scope] what: reason` on stderr, the
 * fallback the caller's to describe. A package writes its lines through this
 * so an app can route them by scope.
 */

export function failureReason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function reportFailure(scope: string, what: string, err: unknown): void {
	console.error(`[${scope}] ${what}:`, failureReason(err));
}

export interface ThrottledReportOptions {
	/** The line, given how many occurrences it stands for, itself included. */
	line: (count: number) => string;
	/** The window, read per occurrence so a test or an operator can change it. Zero prints every one. */
	everyMs: () => number;
}

export interface ThrottledReport {
	/** Count one occurrence, and print when the window has passed. Never throws. */
	(err: unknown): void;
	/** Forget the count and the window. For tests. */
	reset(): void;
}

interface ThrottleState {
	suppressed: number;
	lastAt: number;
}

/**
 * A failure line for something that fails per request, where one line ever
 * hides an outage and one line per request is the outage: one line per
 * window, carrying the count it suppressed, is how an operator tells a blink
 * from an outage. Never throws — the caller is mid-way through an answer it
 * has already decided on. The state is per process rather than per module so
 * a development server's reloads keep the window.
 */
export function throttledReport(
	scope: string,
	name: string,
	options: ThrottledReportOptions,
): ThrottledReport {
	const state = processSingleton<ThrottleState>(
		`report:${scope}:${name}`,
		() => ({ suppressed: 0, lastAt: 0 }),
	);
	const report = (err: unknown): void => {
		try {
			state.suppressed += 1;
			const now = Date.now();
			if (state.lastAt !== 0 && now - state.lastAt < options.everyMs()) return;
			console.error(
				`[${scope}] ${options.line(state.suppressed)}:`,
				failureReason(err),
			);
			state.lastAt = now;
			state.suppressed = 0;
		} catch {}
	};
	return Object.assign(report, {
		reset() {
			state.suppressed = 0;
			state.lastAt = 0;
		},
	});
}
