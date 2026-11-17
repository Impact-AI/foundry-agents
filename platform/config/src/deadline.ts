/**
 * Run work under a deadline, with both halves a bound needs.
 *
 * The abort signal stops the work: without it an SDK keeps retrying in the
 * background after the caller stopped waiting, and a process under load
 * accumulates abandoned requests. The race bounds the caller, whether or not
 * every layer of the SDK honours the signal.
 */
export async function withDeadline<T>(
	run: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	timeoutError: () => Error,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(controller.signal),
			new Promise<never>((_resolve, reject) => {
				// Reject first, then abort: the work may reject synchronously on
				// abort, and the caller must see the deadline's error, not the
				// work's.
				timer = setTimeout(() => {
					reject(timeoutError());
					controller.abort();
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
