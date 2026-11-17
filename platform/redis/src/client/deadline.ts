import { withDeadline } from "@platform/config";
import type { RedisClient } from "bun";

export class RedisCommandTimeout extends Error {
	constructor(
		readonly command: string,
		readonly timeoutMs: number,
	) {
		super(`redis ${command} timed out after ${timeoutMs}ms`);
		this.name = "RedisCommandTimeout";
	}
}

/** Connection plumbing, not commands: never deadlined. */
const NOT_A_COMMAND: ReadonlySet<string> = new Set(["connect", "close"]);

export interface CommandDeadlines {
	timeoutMs: () => number;
	/** Called once per expired command, before the caller sees the rejection. */
	onTimeout: (timeout: RedisCommandTimeout) => void;
}

/**
 * Every command issued through the returned client carries a deadline, so no
 * call site can be unbounded by forgetting one. The deadline chooses no
 * posture: it turns "no answer" into the rejection each caller's `catch`
 * already handles for a Redis error, and what that rejection means stays the
 * caller's.
 *
 * Nothing that is meant to block may go through it: `BLPOP`, `XREAD BLOCK`,
 * `SUBSCRIBE` and a long script are not slow to a deadline, they are wedged.
 */
export function withCommandDeadlines(
	client: RedisClient,
	deadlines: CommandDeadlines,
): RedisClient {
	return new Proxy(client, {
		get(target, prop) {
			// The client reads its own slots off `this`, so it is the receiver
			// throughout, never the proxy.
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function" || NOT_A_COMMAND.has(String(prop))) {
				return value;
			}
			return (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown).apply(
					target,
					args,
				);
				if (!(result instanceof Promise)) return result;
				const command =
					prop === "send" && typeof args[0] === "string"
						? args[0]
						: String(prop);
				const limit = deadlines.timeoutMs();
				return withDeadline(
					() => result,
					limit,
					() => new RedisCommandTimeout(command, limit),
				).catch((err: unknown) => {
					if (err instanceof RedisCommandTimeout) deadlines.onTimeout(err);
					throw err;
				});
			};
		},
		set(target, prop, value) {
			Reflect.set(target, prop, value, target);
			return true;
		},
	});
}
