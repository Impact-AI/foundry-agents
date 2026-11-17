import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { fakeConfigStore } from "@platform/config/testing";
import {
	completion,
	configure,
	type RecordedRequest,
	recordRequests,
} from "@platform/llm/testing";
import { closeRedis, type KeyNamespace } from "@platform/redis";
import {
	REDIS_AVAILABLE,
	sweepNamespace,
	throwawayNamespace,
} from "@platform/redis/testing";
import { scopedEnv } from "@platform/test-support";
import { resetAgentSettings } from "../settings";
import { generateTitle } from "./generate-title";

/**
 * The bounds on a title, against the provider's one boundary: how many reach
 * it at once from this replica, and how many one person may have written
 * where there is a fleet to keep count.
 */
const TURNS = [{ role: "user" as const, content: "Where are the old maps?" }];
const namespaces: KeyNamespace[] = [];
let held: Promise<void> | null = null;
let requests: RecordedRequest[] = [];
let restore: (() => void)[] = [];

function keys(): KeyNamespace {
	const ns = throwawayNamespace();
	namespaces.push(ns);
	return ns;
}

beforeAll(() => {
	restore = [
		configure({
			AZURE_OPENAI_RESOURCE_NAME: "account",
			AZURE_OPENAI_CHAT_DEPLOYMENT: "chat",
			AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT: "small",
		}),
		fakeConfigStore({
			agent: { titlesPerResource: { burst: 2, refillPerMinute: 1 } },
		}),
		resetAgentSettings,
	];
	resetAgentSettings();
	({ requests } = recordRequests(() => {
		const answer = completion("Old maps");
		if (!held) return answer;
		const until = held;
		return new Response(
			new ReadableStream({
				async start(controller) {
					await until;
					controller.enqueue(new Uint8Array(await answer.arrayBuffer()));
					controller.close();
				},
			}),
			{ status: answer.status, headers: answer.headers },
		);
	}));
});

afterEach(async () => {
	await Promise.all(namespaces.splice(0).map(sweepNamespace));
});

afterAll(async () => {
	for (const undo of restore.reverse()) undo();
	await closeRedis();
});

test("one replica writes at most its cap of titles at once, however many ask together", async () => {
	const restoreEnv = scopedEnv({ TITLE_MAX_INFLIGHT: "1" });
	let release = () => {};
	held = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const before = requests.length;
		const ns = keys();
		const asked = ["a", "b", "c"].map((who) => generateTitle(TURNS, ns, who));
		const [, second, third] = asked;
		expect(await second).toBeNull();
		expect(await third).toBeNull();
		release();
		expect(await asked[0]).toBe("Old maps");
		expect(requests.length).toBe(before + 1);
		// The slot comes back: the next one is written.
		expect(await generateTitle(TURNS, ns, "d")).toBe("Old maps");
	} finally {
		release();
		held = null;
		restoreEnv();
	}
});

test.skipIf(!REDIS_AVAILABLE)(
	"one person spends their own titles and not the fleet's: past their burst they get none while another still does",
	async () => {
		const ns = keys();
		expect(await generateTitle(TURNS, ns, "a")).toBe("Old maps");
		expect(await generateTitle(TURNS, ns, "a")).toBe("Old maps");
		expect(await generateTitle(TURNS, ns, "a")).toBeNull();
		expect(await generateTitle(TURNS, ns, "b")).toBe("Old maps");
	},
);
