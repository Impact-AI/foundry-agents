/**
 * A cap on how much work is in flight at once, process-wide.
 *
 * The cap is a getter rather than a number so a change to the setting applies
 * to the next admission without rebuilding the limiter, and so the limiter can
 * be a process singleton while its setting is read through a memo.
 */

export interface Limiter {
	/** Wait for a slot; the result releases it, once, however often it is called. */
	acquire(signal?: AbortSignal): Promise<() => void>;
	/** Run `work` in a slot, releasing it when the promise settles. */
	run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
	readonly active: number;
	readonly waiting: number;
}

interface Waiter {
	admit: () => void;
	abandon: () => void;
}

export function createLimiter(max: () => number): Limiter {
	let active = 0;
	const queue: Waiter[] = [];

	// A cap read as zero or less would admit nobody for ever; one is the floor.
	const cap = () => Math.max(1, Math.floor(max()));

	function admitWaiting(): void {
		while (active < cap() && queue.length > 0) {
			const next = queue.shift();
			if (!next) return;
			active++;
			next.admit();
		}
	}

	function releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active--;
			admitWaiting();
		};
	}

	async function acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw abortError();
		if (active < cap()) {
			active++;
			return releaser();
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				admit: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				abandon: () => reject(abortError()),
			};
			function onAbort() {
				const at = queue.indexOf(waiter);
				if (at >= 0) queue.splice(at, 1);
				waiter.abandon();
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			queue.push(waiter);
		});
		return releaser();
	}

	return {
		acquire,
		async run(work, signal) {
			const release = await acquire(signal);
			try {
				return await work();
			} finally {
				release();
			}
		},
		get active() {
			return active;
		},
		get waiting() {
			return queue.length;
		},
	};
}

/** The rejection the AI SDK raises for an aborted wait, so one reader covers both. */
function abortError(): DOMException {
	return new DOMException("Wait for a slot was aborted", "AbortError");
}
