import { afterAll, afterEach, expect, test } from "bun:test";
import {
	resetAzureCredential,
	resetSingleton,
	setAzureCredential,
} from "@platform/config";
import { scopedEnv } from "@platform/test-support";
import { RedisClient } from "bun";
import { REDIS_TOKEN_PROVIDER } from "./client/auth";
import { closeRedis, getRedis } from "./client/connection";
import { closeSubscriber, publish, subscribe } from "./pubsub";
import { REDIS_AVAILABLE, throwawayNamespace } from "./testing/real-server";

/**
 * The fleet's channels on a real server: a message reaches every listener of
 * its channel and no other, how many heard it is answered, a closed
 * subscription hears nothing more, and a subscriber whose connection the
 * server killed is redialled and subscribed again.
 */

const t = test.skipIf(!REDIS_AVAILABLE);
const keys = throwawayNamespace();

afterEach(() => closeSubscriber());
afterAll(async () => {
	closeSubscriber();
	await closeRedis();
});

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

t(
	"a message reaches every listener of its channel and nobody else's",
	async () => {
		const a = keys.key("channel", "a");
		const b = keys.key("channel", "b");
		const heard: string[] = [];
		const first = await subscribe(a, (m) => heard.push(`1:${m}`));
		const second = await subscribe(a, (m) => heard.push(`2:${m}`));
		const other = await subscribe(b, (m) => heard.push(`b:${m}`));
		expect(first && second && other).toBeTruthy();
		// One connection, one subscription to the channel: one hearer as Redis counts.
		expect(await publish(a, "hello")).toBe(1);
		await until(() => heard.length === 2);
		expect(heard.sort()).toEqual(["1:hello", "2:hello"]);
		await first?.close();
		await first?.close();
		await publish(a, "again");
		await until(() => heard.length === 3);
		expect(heard).toContain("2:again");
		expect(heard).not.toContain("1:again");
		await second?.close();
		expect(await publish(a, "nobody")).toBe(0);
		await other?.close();
	},
);

t(
	"a subscriber the server dropped is redialled and hears its channels again",
	async () => {
		const restore = scopedEnv({ REDIS_RETRY_COOLDOWN_MS: "0" });
		try {
			const channel = keys.key("channel", "redial");
			const heard: string[] = [];
			await subscribe(channel, (m) => heard.push(m));
			const redis = await getRedis();
			await redis?.send("CLIENT", ["KILL", "TYPE", "pubsub"]);
			const deadline = Date.now() + 15_000;
			while ((await publish(channel, "back")) !== 1) {
				if (Date.now() > deadline) throw new Error("never resubscribed");
				await Bun.sleep(100);
			}
			await until(() => heard.includes("back"));
		} finally {
			restore();
		}
	},
	20_000,
);

t(
	"the Entra form's subscriber is redialled after a loss, with its token's refresh still pending",
	async () => {
		// The server's own user for the object id, its password the token.
		const objectId = `pubsub-${crypto.randomUUID().slice(0, 8)}`;
		const admin = new RedisClient(process.env.REDIS_URL);
		await admin.send("ACL", [
			"SETUSER",
			objectId,
			"on",
			">token",
			"~*",
			"&*",
			"+@all",
		]);
		const at = new URL(process.env.REDIS_URL ?? "");
		closeSubscriber();
		await closeRedis();
		setAzureCredential({
			getToken: async () => ({
				token: "token",
				expiresOnTimestamp: Date.now() + 3_600_000,
			}),
		});
		const restore = scopedEnv({
			REDIS_URL: `redis://${objectId}@${at.host}`,
			REDIS_RETRY_COOLDOWN_MS: "0",
		});
		try {
			const channel = keys.key("channel", "entra-redial");
			const heard: string[] = [];
			expect(await subscribe(channel, (m) => heard.push(m))).not.toBeNull();
			expect(await publish(channel, "first")).toBe(1);
			await admin.send("CLIENT", ["KILL", "USER", objectId, "TYPE", "pubsub"]);
			const deadline = Date.now() + 5_000;
			while ((await publish(channel, "back")) !== 1) {
				if (Date.now() > deadline) throw new Error("never resubscribed");
				await Bun.sleep(100);
			}
			await until(() => heard.includes("back"));
		} finally {
			closeSubscriber();
			await closeRedis();
			restore();
			resetAzureCredential();
			resetSingleton(REDIS_TOKEN_PROVIDER);
			await admin.send("ACL", ["DELUSER", objectId]);
			admin.close();
		}
	},
	20_000,
);

/** The server's ids of the pub/sub connections `user` holds. */
async function pubsubIds(admin: RedisClient, user: string): Promise<string[]> {
	const list = String(await admin.send("CLIENT", ["LIST", "TYPE", "pubsub"]));
	return list
		.split("\n")
		.filter((line) => line.includes(` user=${user} `))
		.map((line) => /(?:^| )id=(\d+)/.exec(line)?.[1] ?? "");
}

t(
	"a replacement that cannot be dialled before the token expires is tried again, and the subscriber is replaced without a loss",
	async () => {
		const objectId = `pubsub-${crypto.randomUUID().slice(0, 8)}`;
		const admin = new RedisClient(process.env.REDIS_URL);
		const user = (password: string) =>
			admin.send("ACL", [
				"SETUSER",
				objectId,
				"on",
				"resetpass",
				`>${password}`,
				"~*",
				"&*",
				"+@all",
			]);
		await user("token");
		const at = new URL(process.env.REDIS_URL ?? "");
		closeSubscriber();
		await closeRedis();
		const expiresOnTimestamp = Date.now() + 6_000;
		setAzureCredential({
			getToken: async () => ({ token: "token", expiresOnTimestamp }),
		});
		const restore = scopedEnv({
			REDIS_URL: `redis://${objectId}@${at.host}`,
			REDIS_RETRY_COOLDOWN_MS: "60000",
		});
		try {
			const channel = keys.key("channel", "entra-refresh");
			const heard: string[] = [];
			expect(await subscribe(channel, (m) => heard.push(m))).not.toBeNull();
			const [first] = await pubsubIds(admin, objectId);
			// The refresh, half-way to the expiry, is refused; the connection it would replace stays.
			await user("another");
			await Bun.sleep(3_750);
			expect(await pubsubIds(admin, objectId)).toEqual([first as string]);
			await user("token");
			// The server never dropped it: only a refresh planned again replaces the connection.
			const deadline = Date.now() + 4_000;
			for (;;) {
				const ids = await pubsubIds(admin, objectId);
				if (ids.length === 1 && ids[0] !== first) break;
				if (Date.now() > deadline) throw new Error("never replaced");
				await Bun.sleep(50);
			}
			expect(await admin.publish(channel, "after")).toBe(1);
			await until(() => heard.includes("after"));
		} finally {
			closeSubscriber();
			await closeRedis();
			restore();
			resetAzureCredential();
			resetSingleton(REDIS_TOKEN_PROVIDER);
			await admin.send("ACL", ["DELUSER", objectId]);
			admin.close();
		}
	},
	20_000,
);
