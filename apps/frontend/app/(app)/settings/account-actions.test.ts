import { expect, test } from "bun:test";
import { eraseAnswer, leaveErased } from "./AccountActions";

test("after an erase the person ends at the door even when the sign-out fails", async () => {
	const went: string[] = [];
	await leaveErased(
		async () => {},
		(url) => went.push(url),
	);
	expect(went).toEqual([]);
	await leaveErased(
		async () => {
			throw new Error("sign-out failed");
		},
		(url) => went.push(url),
	);
	expect(went).toEqual(["/login?left=erased"]);
});

test("a delete is erased on success or on the erase's own 401; any other 401 is sent to sign in, never told it was erased", async () => {
	const answer = (status: number, body?: unknown) =>
		eraseAnswer(
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
			}),
		);
	expect(await answer(204)).toBe("erased");
	expect(await answer(401, { code: "account_erased" })).toBe("erased");
	expect(await answer(401, { code: "unauthenticated" })).toBe("sign-in");
	expect(await answer(401)).toBe("sign-in");
	expect(await answer(503, { code: "erase_incomplete" })).toBe("failed");
});
