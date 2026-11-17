import { afterAll, expect, test } from "bun:test";
import { claimHolder, claimOnce, extendClaim, releaseClaim } from "./claim";
import { closeRedis } from "./client/connection";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "./testing/real-server";

const t = test.skipIf(!REDIS_AVAILABLE);
const keys = throwawayNamespace();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
	await sweepNamespace(keys);
	await closeRedis();
});

t(
	"the first caller claims; later ones learn who holds it, a retry included",
	async () => {
		const key = keys.key("claim", "turn-1");
		expect(await claimOnce(key, "replica-a", 30_000)).toEqual({
			outcome: "claimed",
		});
		expect(await claimOnce(key, "replica-b", 30_000)).toEqual({
			outcome: "held",
			owner: "replica-a",
		});
		expect(await claimOnce(key, "replica-a", 30_000)).toEqual({
			outcome: "held",
			owner: "replica-a",
		});
	},
);

t("the holder is read without taking the claim", async () => {
	const key = keys.key("claim", "turn-read");
	expect(await claimHolder(key)).toEqual({ outcome: "free" });
	await claimOnce(key, "replica-a", 30_000);
	expect(await claimHolder(key)).toEqual({
		outcome: "held",
		owner: "replica-a",
	});
	expect(await releaseClaim(key, "replica-a")).toBe("released");
	expect(await claimHolder(key)).toEqual({ outcome: "free" });
});

t("only the holder releases", async () => {
	const key = keys.key("claim", "turn-2");
	await claimOnce(key, "replica-a", 1_000);
	expect(await releaseClaim(key, "replica-b")).toBe("not-held");
	expect(await claimOnce(key, "replica-b", 1_000)).toMatchObject({
		outcome: "held",
	});
	expect(await releaseClaim(key, "replica-a")).toBe("released");
	expect(await releaseClaim(key, "replica-a")).toBe("not-held");
	expect(await claimOnce(key, "replica-b", 1_000)).toEqual({
		outcome: "claimed",
	});
});

t(
	"a claim expires on its TTL, and a release by its previous owner leaves the new one alone",
	async () => {
		const key = keys.key("claim", "turn-3");
		await claimOnce(key, "replica-a", 100);
		await sleep(150);
		expect(await claimOnce(key, "replica-b", 30_000)).toEqual({
			outcome: "claimed",
		});
		expect(await releaseClaim(key, "replica-a")).toBe("not-held");
		expect(await claimOnce(key, "replica-c", 30_000)).toEqual({
			outcome: "held",
			owner: "replica-b",
		});
	},
);

t(
	"only the holder extends, and an extended claim outlives its first TTL",
	async () => {
		const key = keys.key("claim", "turn-4");
		expect(await extendClaim(key, "replica-a", 1_000)).toBe("not-held");
		await claimOnce(key, "replica-a", 150);
		expect(await extendClaim(key, "replica-b", 30_000)).toBe("not-held");
		expect(await extendClaim(key, "replica-a", 30_000)).toBe("extended");
		await sleep(200);
		expect(await claimHolder(key)).toEqual({
			outcome: "held",
			owner: "replica-a",
		});
	},
);
