/**
 * A request body held to a byte ceiling before it is parsed. `content-length`
 * is a claim — a chunked request omits it and a hostile one understates it —
 * and a parse assembles the whole body in heap before any size can be read
 * off the result. So the cheap check refuses the declared case, and a
 * counting stream in front of the parse refuses the rest with no more than
 * `limit` bytes ever resident.
 */

export class BodyOverLimit extends Error {
	constructor() {
		super("body-over-limit");
		this.name = "BodyOverLimit";
	}
}

/** Whether a declared size — a request's, or an upstream answer's — already exceeds `limit`. */
export function overDeclaredLimit(
	message: { headers: Headers },
	limit: number,
): boolean {
	const declared = Number(message.headers.get("content-length") ?? "");
	return Number.isFinite(declared) && declared > limit;
}

/** The request with its body counted as it streams; the byte past `limit` errors the stream. */
export function cappedRequest(request: Request, limit: number): Request {
	if (!request.body) return request;
	let seen = 0;
	const counted = request.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > limit) controller.error(new BodyOverLimit());
				else controller.enqueue(chunk);
			},
		}),
	);
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: counted,
		// The caller's abort still ends the read.
		signal: request.signal,
		// A streamed request body needs half duplex; the option is real but absent from the lib type.
		duplex: "half",
	} as RequestInit);
}

/** Whether a parse failed because the meter spoke, directly or as a cause. */
export function isBodyOverLimit(err: unknown): boolean {
	return (
		err instanceof BodyOverLimit ||
		(err instanceof Error && err.cause instanceof BodyOverLimit)
	);
}

/**
 * How many array elements and object keys a parsed body may hold, in all,
 * before a schema reads it. A byte ceiling does not bound what reading it
 * costs: a megabyte of JSON is half a million array elements, or as many
 * object keys, and a validator that keeps an issue for every element it
 * refuses holds hundreds of megabytes while it says no, where one that walks
 * an object's keys walks every one. A conversation's thread costs about ten
 * a message — the message's keys, its content and its tool calls — so a
 * thread of a few thousand messages, its tools and its context fit with
 * room, and a body at the bound costs a validator tens of megabytes, not
 * hundreds.
 */
export const MAX_BODY_ELEMENTS = 50_000;

/**
 * Whether a parsed body holds more than `limit` array elements and object
 * keys in all, however they are nested. A value is counted by its length
 * or its keys before it is walked, so a body that is one long array, or one
 * object with a great many keys, is refused without a visit to any value in
 * it.
 */
export function overElementLimit(
	body: unknown,
	limit = MAX_BODY_ELEMENTS,
): boolean {
	let seen = 0;
	const open: unknown[] = [body];
	while (open.length) {
		const value = open.pop();
		if (value === null || typeof value !== "object") continue;
		const inner = Array.isArray(value) ? value : Object.values(value);
		seen += inner.length;
		if (seen > limit) return true;
		for (const item of inner)
			if (item !== null && typeof item === "object") open.push(item);
	}
	return false;
}
