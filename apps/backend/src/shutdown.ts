/**
 * What a replica does when the platform tells it to go, in one order and
 * inside the grace the platform gives it (`terminationGracePeriodSeconds`,
 * 30 s in the template):
 *
 * 1. drain — tell every live session held here to reopen elsewhere, stop
 *    accepting, let the turns in flight finish — for as long as the drain's
 *    share of the grace allows;
 * 2. stop the host, which ends the turns still streaming, releases their
 *    claims and runs its queued work, while Redis and the database are
 *    still open to it;
 * 3. close everything else that was opened, all at once;
 * 4. flush the telemetry, and exit.
 *
 * The grace is shared out below, once, so the parts add up to it: a drain
 * that runs to its deadline — the one case in which turns are still
 * running — still leaves the host's stop the whole of what it asks for. A
 * drain that ends early leaves it the difference as well.
 *
 * Nothing here waits without a bound. A step that has not answered inside
 * its own is left to finish by itself and the next one starts, so one
 * thing that hangs never keeps the others, or the flush, from running
 * before the kill.
 */
export interface ShutdownSteps {
	/** Everything that waits on people: the live sessions' grace, the turns in flight. */
	drain(): Promise<void>;
	/** The host's stop: what ends the turns still running. It runs alone, before anything it needs is closed. */
	stop(): unknown;
	/** Each closes one thing; all are started together once the host has stopped, whatever the others do. */
	close: readonly (() => unknown)[];
	/** The last thing before the exit, after every close. */
	flush(): Promise<void>;
}

export interface ShutdownBounds {
	/** The whole of it, from the signal to the kill. */
	graceMs: number;
	/** How long the drain is given. */
	drainMs: number;
	/** How long the host's stop is given at the least. */
	stopMs: number;
	/** How long the closes are given, together. */
	closeMs: number;
	/** How long the flush is waited for. */
	flushMs: number;
	/** What is left unspent, for the exit itself. */
	exitMs: number;
}

/**
 * The grace the template gives a replica between the signal and the kill,
 * and how it is spent. The host's stop waits up to five seconds for the
 * turns it ends and for its queues (`@platform/agent`), so it is given
 * six; the closes that follow are local and run together; the flush sends
 * what the telemetry still holds; and a second is left for the exit.
 */
export const SHUTDOWN: ShutdownBounds = {
	graceMs: 30_000,
	stopMs: 6_000,
	closeMs: 1_000,
	flushMs: 2_000,
	exitMs: 1_000,
	// What the rest leaves. The live sessions take `live.drainGraceMs` to
	// reopen elsewhere and then up to `live.settleWaitMs` each for their last
	// words before their threads are written, so the two together are kept
	// well inside this (`docs/configuration.md`): a session still settling
	// at the deadline is closed here and settled by another replica's sweep.
	drainMs: 20_000,
};

/** `work`, waited for no longer than `ms`: true when it finished, with or without an error. */
async function within(
	ms: number,
	work: () => unknown,
	failed: string,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const done = (async () => work())().then(
		() => true,
		(err) => {
			console.error(failed, err);
			return true;
		},
	);
	const finished = await Promise.race([
		done,
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
		}),
	]);
	clearTimeout(timer);
	return finished;
}

const seconds = (ms: number) => Math.round(ms / 1000);

/** True when the drain finished inside its deadline. Never rejects, and never waits past its bounds. */
export async function shutDown(
	steps: ShutdownSteps,
	bounds: Partial<ShutdownBounds> = {},
): Promise<boolean> {
	const began = Date.now();
	const { graceMs, drainMs, stopMs, closeMs, flushMs, exitMs } = {
		...SHUTDOWN,
		...bounds,
	};
	const drained = await within(
		drainMs,
		steps.drain,
		"[backend] the drain failed:",
	);
	if (!drained)
		console.warn(
			`[backend] still draining after ${seconds(drainMs)} s: ending what is in flight`,
		);
	// Its own share, and whatever a drain that ended early left of the grace.
	const stopBound = Math.max(
		stopMs,
		graceMs - (Date.now() - began) - closeMs - flushMs - exitMs,
	);
	if (!(await within(stopBound, steps.stop, "[backend] shutdown error:")))
		console.warn(
			`[backend] the host has not stopped after ${seconds(stopBound)} s: going on without it`,
		);
	const closed = await Promise.all(
		steps.close.map((close) =>
			within(closeMs, close, "[backend] shutdown error:"),
		),
	);
	const hung = closed.filter((finished) => !finished).length;
	if (hung > 0)
		console.warn(
			`[backend] ${hung} of ${closed.length} closes had not answered after ${seconds(closeMs)} s: going on without them`,
		);
	if (!(await within(flushMs, steps.flush, "[backend] shutdown error:")))
		console.warn("[backend] the telemetry was not flushed in time");
	return drained;
}
