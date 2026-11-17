import { configureLimits } from "../limits/document";

/** Serve `document` as the stored limits from now on, cold. */
export function useLimits(document: unknown): void {
	configureLimits({ read: async () => document });
}

/** Back to the compiled-in defaults, read from nowhere. */
export function useDefaultLimits(): void {
	useLimits(null);
}
