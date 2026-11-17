import { AsyncLocalStorage } from "node:async_hooks";
import type { Tier } from "@platform/identity/claims";
import type { LiveContextLine } from "../contract/messages";

/**
 * Whose turn this is, readable anywhere inside the request handling it: the
 * host runs every product tool inside the scope, so a tool asks
 * `currentTurn()` for the caller rather than being handed one by the model.
 * Async context and not a module-level slot, because a replica serves many
 * turns at once.
 */
export interface TurnScope {
	resourceId: string | null;
	threadId: string | null;
	surface: string;
	languageName: string;
	liveContext: readonly LiveContextLine[];
	/** Who is asking, from the backend's verified claims; null for a turn with nobody verified behind it. */
	caller: CallerIdentity | null;
}

/**
 * The person behind a turn, as the backend's gate read them: the object id,
 * the group ids and the tier, from the account's row. What a tool hands to
 * anything that decides who may read what or what a call costs; never read
 * from a request body.
 */
export interface CallerIdentity {
	oid: string;
	groups: readonly string[];
	tier: Tier;
}

/** The surface a turn that declared none is on: matches no surface-scoped skill or block. */
const UNDECLARED_SURFACE = "undeclared";

export const UNSCOPED_TURN: TurnScope = {
	resourceId: null,
	threadId: null,
	surface: UNDECLARED_SURFACE,
	languageName: "English",
	liveContext: [],
	caller: null,
};

const storage = new AsyncLocalStorage<TurnScope>();

export function runInTurnScope<T>(scope: TurnScope, fn: () => T): T {
	return storage.run(scope, fn);
}

/** What a product's tool may ask about the turn it is answering in. */
export type CurrentTurn = Pick<
	TurnScope,
	"resourceId" | "surface" | "languageName" | "caller"
>;

/**
 * The turn a product tool is running in. Outside a turn it is the unscoped
 * answer, never a throw.
 */
export function currentTurn(): CurrentTurn {
	const { resourceId, surface, languageName, caller } =
		storage.getStore() ?? UNSCOPED_TURN;
	return { resourceId, surface, languageName, caller };
}
