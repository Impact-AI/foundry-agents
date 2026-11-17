import { afterAll, afterEach, expect, test } from "bun:test";
import { fakeConfigStore } from "@platform/config/testing";
import { closeRedis, type KeyNamespace } from "@platform/redis";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "@platform/redis/testing";
import { DEFAULT_AGENT_SETTINGS } from "../settings";
import { claimTurn, deriveTurnKey } from "./idempotency";
import { spendTurn } from "./rate-limit";

/**
 * The two guards that need the fleet's state, against a real server, and
 * their posture without one: a claim that cannot be made is `unavailable`
 * and a bucket that cannot be read admits.
 */
const withRedis = test.skipIf(!REDIS_AVAILABLE);
const withoutRedis = test.skipIf(REDIS_AVAILABLE);
const namespaces: KeyNamespace[] = [];
const restoreConfig = fakeConfigStore({});

function keys(): KeyNamespace {
	const ns = throwawayNamespace();
	namespaces.push(ns);
	return ns;
}

afterEach(async () => {
	await Promise.all(namespaces.splice(0).map(sweepNamespace));
});

afterAll(async () => {
	restoreConfig();
	await closeRedis();
});

const turn = {
	resourceId: "a::1",
	threadId: "t1",
	messages: [{ id: "m1", role: "user" as const, content: "hi" }],
};

test("the turn key is the explicit one else the last message's id, always under the resource and thread, else nothing to coordinate on", () => {
	expect(deriveTurnKey(turn)).toBe("a::1:t1:m1");
	expect(deriveTurnKey({ ...turn, turnKey: "given" })).toBe("a::1:t1:given");
	// A key chosen to be somebody else's is still only the chooser's.
	expect(
		deriveTurnKey({ ...turn, resourceId: "b::2", turnKey: "given" }),
	).not.toBe(deriveTurnKey({ ...turn, turnKey: "given" }));
	expect(deriveTurnKey({ ...turn, messages: [{}] })).toBeNull();
});

withRedis(
	"the first claim wins, a second is held until the first is released, and a released turn can be claimed again",
	async () => {
		const ns = keys();
		const first = await claimTurn(ns, "k");
		expect(first.outcome).toBe("claimed");
		expect((await claimTurn(ns, "k")).outcome).toBe("held");
		await first.release();
		expect((await claimTurn(ns, "k")).outcome).toBe("claimed");
		expect((await claimTurn(ns, null)).outcome).toBe("unavailable");
	},
);

withRedis(
	"a resource may start its burst of turns and is then refused with a wait, while another resource is untouched",
	async () => {
		const ns = keys();
		for (let n = 0; n < DEFAULT_AGENT_SETTINGS.turns.burst; n++) {
			expect(await spendTurn(ns, "a::1")).toEqual({ allowed: true });
		}
		const refused = await spendTurn(ns, "a::1");
		expect(refused.allowed).toBe(false);
		if (!refused.allowed)
			expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		expect(await spendTurn(ns, "b::2")).toEqual({ allowed: true });
	},
);

withoutRedis(
	"without Redis a claim is unavailable and a spend admits: neither is a reason to refuse a turn",
	async () => {
		const ns = throwawayNamespace();
		expect((await claimTurn(ns, "k")).outcome).toBe("unavailable");
		expect((await claimTurn(ns, "k")).outcome).toBe("unavailable");
		expect(await spendTurn(ns, "a::1")).toEqual({ allowed: true });
	},
);
