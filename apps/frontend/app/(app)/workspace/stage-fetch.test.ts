import { expect, test } from "bun:test";
import { StageReadFailed } from "@/src/stage/tools";
import { read } from "./stage-fetch";

const answers = (status: number, body: unknown) => async () =>
	Response.json(body, { status });

test("a read answers its body, null for what is not there, and fails for anything else", async () => {
	expect(await read("/api/x", answers(200, { documents: [] }))).toEqual({
		documents: [],
	});
	expect(await read("/api/x", answers(404, { code: "not_found" }))).toBeNull();
	for (const [status, code] of [
		[401, "unauthenticated"],
		[500, "generic"],
		[503, "backend_unreachable"],
	] as const) {
		const err = await read("/api/x", answers(status, { code })).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(StageReadFailed);
		expect((err as StageReadFailed).code).toBe(code);
	}
	const offline = await read("/api/x", async () => {
		throw new TypeError("offline");
	}).catch((e) => e);
	expect(offline).toBeInstanceOf(StageReadFailed);
});
