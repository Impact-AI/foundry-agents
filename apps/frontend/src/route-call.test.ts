import { describe, expect, test } from "bun:test";
import { callRoute, type Send } from "./route-call";

const answering =
	(res: () => Response): Send =>
	async () =>
		res();

describe("a call to one of this app's routes", () => {
	test("a yes is the body", async () => {
		expect(
			await callRoute(
				answering(() => Response.json({ id: "c1" })),
				"/api/x",
			),
		).toEqual({ ok: true, body: { id: "c1" } });
	});

	test("a no is read as every refusal is: by its code, else by its status", async () => {
		const call = (res: Response) =>
			callRoute(
				answering(() => res),
				"/api/x",
			);
		expect(await call(new Response(null, { status: 429 }))).toEqual({
			ok: false,
			code: "rate_limited",
		});
		expect(
			await call(
				Response.json({ code: "rate_limited", pool: true }, { status: 429 }),
			),
		).toEqual({ ok: false, code: "pool_exhausted" });
		expect(await call(new Response("no", { status: 404 }))).toEqual({
			ok: false,
			code: "not_found",
		});
		expect(
			await call(Response.json({ code: "nonsense" }, { status: 500 })),
		).toEqual({ ok: false, code: "generic" });
	});

	test("nothing answering is unreachable", async () => {
		const send: Send = async () => {
			throw new TypeError("Failed to fetch");
		};
		expect(await callRoute(send, "/api/x")).toEqual({
			ok: false,
			code: "backend_unreachable",
		});
	});
});
