import { afterAll, afterEach, expect, test } from "bun:test";
import { closeRedis, type KeyNamespace } from "@platform/redis";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import { claimTurn } from "./idempotency";

/**
 * A turn's claim against a real server, for a turn that runs longer than
 * the claim lives: kept, it is still held past its TTL, and once the run
 * stops keeping it, it lapses on the TTL as any other.
 */
const withRedis = test.skipIf(!REDIS_AVAILABLE);
const namespaces: KeyNamespace[] = [];
const restore = scopedEnv({ TURN_CLAIM_TTL_SECONDS: "1" });

afterEach(async () => {
	await Promise.all(namespaces.splice(0).map(sweepNamespace));
});

afterAll(async () => {
	restore();
	await closeRedis();
});

withRedis(
	"a claim the run keeps is held past its TTL, and lapses once the run lets go",
	async () => {
		const ns = throwawayNamespace();
		namespaces.push(ns);
		const claim = await claimTurn(ns, "long");
		expect(claim.outcome).toBe("claimed");
		const stop = claim.keep();
		await Bun.sleep(1600);
		expect((await claimTurn(ns, "long")).outcome).toBe("held");
		stop();
		await Bun.sleep(1300);
		expect((await claimTurn(ns, "long")).outcome).toBe("claimed");
	},
);

test("a turn with nothing to coordinate on has nothing to keep", async () => {
	const claim = await claimTurn(throwawayNamespace(), null);
	expect(claim.outcome).toBe("unavailable");
	claim.keep()();
});
