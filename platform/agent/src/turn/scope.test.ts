import { expect, test } from "bun:test";
import {
	currentTurn,
	runInTurnScope,
	type TurnScope,
	UNSCOPED_TURN,
} from "./scope";

const SCOPE: TurnScope = {
	resourceId: "account-1",
	threadId: "t1",
	surface: "web",
	languageName: "French",
	liveContext: [],
	caller: { oid: "owner", groups: ["g-1"], tier: "base" },
};

test("currentTurn answers from the async context inside a turn, and is the unscoped turn outside one", async () => {
	expect(currentTurn()).toEqual({
		resourceId: null,
		surface: UNSCOPED_TURN.surface,
		languageName: "English",
		caller: null,
	});
	const seen = await runInTurnScope(SCOPE, async () => {
		await Promise.resolve();
		return currentTurn();
	});
	expect(seen).toEqual({
		resourceId: "account-1",
		surface: "web",
		languageName: "French",
		caller: { oid: "owner", groups: ["g-1"], tier: "base" },
	});
	expect(currentTurn().caller).toBeNull();
});
