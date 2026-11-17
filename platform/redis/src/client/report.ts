import { reportFailure } from "@platform/config";

/** One line per failure, with the reason; the fallback is the caller's. */
export function reportRedisFailure(what: string, err: unknown): void {
	reportFailure("redis", what, err);
}
