import { expect, test } from "bun:test";
import { z } from "zod";
import { productTool } from "../../contract/product";
import { UNSCOPED_TURN } from "../../turn/scope";
import { runProductTool } from "./loop";

test("a tool is handed the turn's abort signal beside its arguments", async () => {
	let seen: AbortSignal | undefined;
	const tools = {
		lookup: productTool({
			description: "looks something up",
			parameters: z.object({ q: z.string() }),
			execute: async ({ q }, context) => {
				seen = context?.signal;
				return q;
			},
		}),
	};
	const turn = new AbortController();
	const call = { name: "lookup", arguments: '{"q":"maps"}' };
	expect(await runProductTool(tools, UNSCOPED_TURN, call, turn.signal)).toEqual(
		{ result: "maps", isError: false },
	);
	expect(seen).toBe(turn.signal);
	// A live session's call has no turn to abort it.
	await runProductTool(tools, UNSCOPED_TURN, call);
	expect(seen).toBeUndefined();
});
