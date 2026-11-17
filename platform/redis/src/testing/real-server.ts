import { envString } from "@platform/config";
import { getRedis } from "../client/connection";
import { type KeyNamespace, keyNamespace } from "../keys";

/** The suites that need a server run when `REDIS_URL` is set; CI sets it. */
export const REDIS_AVAILABLE = envString("REDIS_URL") !== undefined;

/** A prefix nothing else writes under, so a suite can sweep its own keys. */
export function throwawayNamespace(): KeyNamespace {
	return keyNamespace(`test-${crypto.randomUUID().slice(0, 8)}`);
}

export async function sweepNamespace(namespace: KeyNamespace): Promise<void> {
	const redis = await getRedis();
	if (!redis) return;
	let cursor = "0";
	do {
		const [next, batch] = (await redis.send("SCAN", [
			cursor,
			"MATCH",
			`${namespace.prefix}:*`,
			"COUNT",
			"200",
		])) as [string, string[]];
		cursor = next;
		if (batch.length > 0) await redis.send("DEL", batch);
	} while (cursor !== "0");
}
