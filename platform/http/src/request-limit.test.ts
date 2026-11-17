import { expect, test } from "bun:test";
import {
	BodyOverLimit,
	cappedRequest,
	isBodyOverLimit,
	MAX_BODY_ELEMENTS,
	overDeclaredLimit,
	overElementLimit,
} from "./request-limit";

function chunked(chunks: string[]): Request {
	return new Request("http://test/body", {
		method: "POST",
		body: new ReadableStream({
			start(controller) {
				for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
				controller.close();
			},
		}),
	});
}

test("a declared length over the limit is refused on the header alone", () => {
	const request = new Request("http://test/body", {
		method: "POST",
		headers: { "content-length": "11" },
		body: "x",
	});
	expect(overDeclaredLimit(request, 10)).toBe(true);
	expect(overDeclaredLimit(request, 11)).toBe(false);
	expect(overDeclaredLimit(chunked(["x"]), 0)).toBe(false);
	// The same claim on an answer from upstream.
	expect(
		overDeclaredLimit(
			new Response("x", { headers: { "content-length": "11" } }),
			10,
		),
	).toBe(true);
});

test("a body that crosses the limit as it streams errors the parse, and one within it is read whole", async () => {
	const over = cappedRequest(chunked(["12345", "67890", "1"]), 10).text();
	await expect(over).rejects.toBeInstanceOf(BodyOverLimit);
	const failure = await cappedRequest(chunked(["12345678901"]), 10)
		.json()
		.then(
			() => null,
			(err: unknown) => err,
		);
	expect(failure).not.toBeNull();
	expect(isBodyOverLimit(failure)).toBe(true);
	expect(await cappedRequest(chunked(["12345", "67890"]), 10).text()).toBe(
		"1234567890",
	);
	expect(isBodyOverLimit(new SyntaxError("json"))).toBe(false);
});

test("the capped request is aborted when the request it was made from is", () => {
	const controller = new AbortController();
	const request = new Request("http://test/body", {
		method: "POST",
		body: "x",
		signal: controller.signal,
	});
	const capped = cappedRequest(request, 10);
	expect(capped.signal.aborted).toBe(false);
	controller.abort();
	expect(capped.signal.aborted).toBe(true);
});

test("a parsed body is held to a count of array elements and object keys in all, however they are nested", () => {
	const thread = {
		messages: Array.from({ length: 400 }, (_, i) => ({
			id: `m${i}`,
			role: "user",
			content: [{ type: "text", text: "Hello" }],
		})),
		tools: [{ name: "showChart", parameters: { required: ["title"] } }],
		context: [],
	};
	expect(overElementLimit(thread)).toBe(false);
	expect(overElementLimit(null)).toBe(false);
	expect(overElementLimit("a string")).toBe(false);

	// One long array, and the same kind of count spread over many short ones under an object.
	const long = Array.from({ length: MAX_BODY_ELEMENTS }, () => 0);
	expect(overElementLimit({ messages: long })).toBe(true);
	expect(overElementLimit({ messages: long.slice(1) })).toBe(false);
	// Each of 101 keys holds one array of 199: the key, the element, its 199.
	const spread = Object.fromEntries(
		Array.from({ length: 101 }, (_, i) => [`k${i}`, [new Array(199).fill(0)]]),
	);
	expect(overElementLimit(spread, 101 * 201 - 1)).toBe(true);
	expect(overElementLimit(spread, 101 * 201)).toBe(false);
	expect(overElementLimit([[], [[]]], 2)).toBe(true);
	expect(overElementLimit([[], [[]]], 3)).toBe(false);

	// An object's keys count as an array's elements do, at any depth.
	const keys = (count: number) =>
		Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 0]));
	expect(overElementLimit(keys(MAX_BODY_ELEMENTS + 1))).toBe(true);
	expect(overElementLimit(keys(MAX_BODY_ELEMENTS))).toBe(false);
	expect(overElementLimit({ state: keys(MAX_BODY_ELEMENTS) })).toBe(true);
	expect(overElementLimit([{ a: 0, b: { c: 0 } }], 3)).toBe(true);
	expect(overElementLimit([{ a: 0, b: { c: 0 } }], 4)).toBe(false);
});

test("a body that is one long array is refused by its length, with no visit to its elements", () => {
	const long = new Array(5_000_000);
	const started = performance.now();
	expect(overElementLimit(long)).toBe(true);
	expect(performance.now() - started).toBeLessThan(50);
});
