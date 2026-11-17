import { DEFAULT_CONFIG_TTL_MS } from "@platform/config/env";
import { readStageToolBriefs, type StageToolBrief } from "../stage/tool-briefs";
import { backendJson, type Caller } from "./client";

/**
 * Facts of the deployment the backend answers and this app holds as
 * configuration of its own nowhere: the agent's id, which the product owns,
 * the tools the product briefs the browser to register, and the byte bounds
 * the backend enforces, which its documents hold. They
 * are the same for every caller — the caller in hand only signs the read —
 * so each is read once per process and served from memory for the pace
 * every stored document is, then read again. A failed refresh serves the
 * last answer; with none there is nothing to serve, and the error crosses.
 */

export interface BackendFacts {
	agentId: string;
	/** The browser registers exactly these; a deployment that briefs none registers none. */
	stageTools: StageToolBrief[];
	limits: { maxRequestBodyBytes: number };
}

interface Memo<T> {
	value: T;
	at: number;
}

/**
 * A read of something every caller gets the same answer to, served from
 * memory for the memo pace and shared by callers that arrive together. A
 * failed refresh serves the last answer; with none, the error crosses.
 */
export function memoised<T, A extends unknown[]>(
	read: (...args: A) => Promise<T>,
) {
	const state: { memo?: Memo<T>; inFlight?: Promise<T> } = {};
	return async (...args: A): Promise<T> => {
		const memo = state.memo;
		if (memo && Date.now() - memo.at < DEFAULT_CONFIG_TTL_MS) return memo.value;
		state.inFlight ??= read(...args)
			.then((value) => {
				state.memo = { value, at: Date.now() };
				return value;
			})
			.finally(() => {
				state.inFlight = undefined;
			});
		try {
			return await state.inFlight;
		} catch (err) {
			if (memo) return memo.value;
			throw err;
		}
	};
}

/** The agent's id, the stage tools and the request-body bound, from `GET /identity/me`. */
export const backendFacts = memoised(
	async (caller: Caller): Promise<BackendFacts> => {
		const { agentId, stageTools, limits } = await backendJson<{
			agentId: string;
			stageTools?: unknown;
			limits: BackendFacts["limits"];
		}>(caller, "/identity/me");
		return { agentId, stageTools: readStageToolBriefs(stageTools), limits };
	},
);
