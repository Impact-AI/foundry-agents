import { describe, expect, test } from "bun:test";
import {
	alreadyWaiting,
	atRest,
	createOutbox,
	joinQueued,
	mayPost,
	type QueueMessage,
	queueMore,
	REST_MS,
	STALL_MS,
	sendAfter,
} from "./send-queue";

const user: QueueMessage = { role: "user" };
const answer: QueueMessage = { role: "assistant" };
const calls = (...ids: string[]): QueueMessage => ({
	role: "assistant",
	toolCalls: ids.map((id) => ({ id })),
});
const result = (id: string): QueueMessage => ({
	role: "tool",
	toolCallId: id,
});

describe("atRest", () => {
	test("a run in flight is never at rest", () => {
		expect(atRest([user, answer], true)).toBe(false);
	});

	test("a finished answer is at rest", () => {
		expect(atRest([user, answer], false)).toBe(true);
		expect(atRest([], false)).toBe(true);
	});

	test("a control's answer as the last message means the follow-up run is about to start", () => {
		expect(atRest([user, calls("a"), result("a")], false)).toBe(false);
	});

	test("a call the page has not answered yet holds the thread", () => {
		expect(atRest([user, calls("a", "b"), result("a")], false)).toBe(false);
		expect(atRest([user, calls("a")], false)).toBe(false);
	});

	test("the follow-up's own answer brings it back to rest", () => {
		expect(atRest([user, calls("a"), result("a"), answer], false)).toBe(true);
	});
});

describe("sendAfter", () => {
	test("waits while the run is in flight or a picture is still being prepared", () => {
		expect(sendAfter([user], true, false)).toBeNull();
		expect(sendAfter([user, answer], false, true)).toBeNull();
	});

	test("a short settle once at rest", () => {
		expect(sendAfter([user, answer], false, false)).toBe(REST_MS);
	});

	test("a longer one when only an unanswered call is in the way, so a stall cannot hold the queue for ever", () => {
		expect(sendAfter([user, calls("a")], false, false)).toBe(STALL_MS);
	});
});

describe("joinQueued", () => {
	test("the first message is queued as it is", () => {
		expect(joinQueued(null, "hello")).toBe("hello");
	});

	test("a second joins the first as its own paragraph", () => {
		expect(joinQueued("hello", "and this")).toBe("hello\n\nand this");
	});
});

describe("mayPost", () => {
	test("a thread at rest takes a turn, unless a live session holds it", () => {
		expect(mayPost([user, answer], false, false)).toBe(true);
		expect(mayPost([user, answer], false, true)).toBe(false);
	});

	test("a run in flight, or a call the page has not answered, does not", () => {
		expect(mayPost([user], true, false)).toBe(false);
		expect(mayPost([user, calls("a")], false, false)).toBe(false);
	});
});

describe("the outbox", () => {
	test("words go straight to the thread, trimmed, unless whoever took it keeps them to send later", () => {
		const direct: string[] = [];
		const kept: string[] = [];
		let busy = false;
		const outbox = createOutbox((text) => {
			direct.push(text);
			return undefined;
		});
		outbox.post("  first  ");
		outbox.take((text) => {
			if (busy) kept.push(text);
			return busy;
		});
		// The thread is at rest: the column keeps nothing, so the words go
		// past the composer and its draft is not theirs to clear.
		outbox.post("second");
		busy = true;
		outbox.post("third");
		outbox.post("   ");
		outbox.take(null);
		outbox.post("fourth");
		expect(direct).toEqual(["first", "second", "fourth"]);
		expect(kept).toEqual(["third"]);
	});
});

describe("two sends in one instant", () => {
	test("words sent on are a turn until their send is over: a second press is kept behind it, or with nobody to keep it is not sent", async () => {
		const direct: string[] = [];
		const kept: string[] = [];
		let finish: () => void = () => {};
		const outbox = createOutbox((text) => {
			direct.push(text);
			return new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		// Nobody has the outbox: the second press, before the page has drawn the first, sends nothing.
		outbox.post("first");
		outbox.post("second");
		expect(direct).toEqual(["first"]);
		// The column has it and sees no run yet; the outbox tells it one is on its way.
		outbox.take((text, busy) => {
			if (busy) kept.push(text);
			return busy;
		});
		outbox.post("third");
		expect(direct).toEqual(["first"]);
		expect(kept).toEqual(["third"]);
		// Once that send is over, words go on as before.
		finish();
		await Promise.resolve();
		await Promise.resolve();
		outbox.post("fourth");
		expect(direct).toEqual(["first", "fourth"]);
	});

	test("the same words pressed again while they are on their way are dropped, and other words are kept behind them", async () => {
		const direct: string[] = [];
		const kept: string[] = [];
		let finish: () => void = () => {};
		const outbox = createOutbox((text) => {
			direct.push(text);
			return new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		outbox.take((text, busy) => {
			if (busy) kept.push(text);
			return busy;
		});
		outbox.post("Show me the library");
		outbox.post("Show me the library");
		outbox.post("  Show me the library ");
		expect(direct).toEqual(["Show me the library"]);
		expect(kept).toEqual([]);
		outbox.post("Open the plan");
		expect(kept).toEqual(["Open the plan"]);
		// Once the turn is over the same chip is a new press.
		finish();
		await Promise.resolve();
		await Promise.resolve();
		outbox.post("Show me the library");
		expect(direct).toEqual(["Show me the library", "Show me the library"]);
	});

	test("words already the last of what waits are not added again", () => {
		expect(alreadyWaiting(null, "a")).toBe(false);
		const one = queueMore(null, "a", false);
		expect(alreadyWaiting(one, "a")).toBe(true);
		expect(alreadyWaiting(one, "b")).toBe(false);
		const two = queueMore(one, "b", false);
		expect(alreadyWaiting(two, "b")).toBe(true);
		expect(alreadyWaiting(two, "a")).toBe(false);
	});

	test("a send that sent nothing leaves the outbox free", () => {
		const direct: string[] = [];
		const outbox = createOutbox((text) => {
			direct.push(text);
			return undefined;
		});
		outbox.post("first");
		outbox.post("second");
		expect(direct).toEqual(["first", "second"]);
	});
});

describe("what waits", () => {
	test("a chip's words alone go alone; once typed words join them, all of it goes as typed", () => {
		const chip = queueMore(null, "show the library", false);
		expect(chip).toEqual({ text: "show the library", typed: false });
		expect(queueMore(chip, "and the chart", false).typed).toBe(false);
		expect(queueMore(chip, "typed", true)).toEqual({
			text: "show the library\n\ntyped",
			typed: true,
		});
		expect(queueMore(queueMore(null, "typed", true), "chip", false).typed).toBe(
			true,
		);
	});
});
