/**
 * A limiter as middleware, so the cap sits on the model and no call site can
 * step around it. A streamed call holds its slot until the stream is drained,
 * cancelled or aborted: the provider is busy for that whole time, not only
 * until the headers arrive.
 */
import type { LanguageModelMiddleware } from "ai";
import type { Limiter } from "./limiter";

export function concurrencyMiddleware(
	limiter: Limiter,
): LanguageModelMiddleware {
	return {
		wrapGenerate: ({ doGenerate, params }) =>
			limiter.run(() => Promise.resolve(doGenerate()), params.abortSignal),
		async wrapStream({ doStream, params }) {
			const slot = await limiter.acquire(params.abortSignal);
			// A consumer that stops reading without cancelling would hold the slot;
			// its abort signal is the other way it says it has stopped caring. The
			// listener goes with the slot, so a signal that outlives the call
			// holds nothing of it.
			const signal = params.abortSignal;
			const release = () => {
				signal?.removeEventListener("abort", release);
				slot();
			};
			signal?.addEventListener("abort", release, { once: true });
			try {
				const result = await doStream();
				return { ...result, stream: releasedWhenDone(result.stream, release) };
			} catch (error) {
				release();
				throw error;
			}
		},
	};
}

function releasedWhenDone<T>(
	stream: ReadableStream<T>,
	release: () => void,
): ReadableStream<T> {
	const reader = stream.getReader();
	return new ReadableStream<T>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					release();
					controller.close();
				} else {
					controller.enqueue(value);
				}
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		cancel(reason) {
			release();
			return reader.cancel(reason);
		},
	});
}
