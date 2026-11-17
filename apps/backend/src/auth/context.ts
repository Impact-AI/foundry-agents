import type { Account, AccountReading, CallerClaims } from "@platform/identity";
import type { UsageSubject } from "@platform/metering";

/**
 * What the gate attaches to every request past it, typed so a route reads a
 * verified value and never a header. One account is one person, so the
 * caller's account id is the whole scope: the agent's memory, the threads,
 * and — as `subject` — what allowances are charged to. `reading` is the one
 * read of the account's row a request makes, taken by the gate that refuses
 * an erased account's old sessions and reused by `requireStanding`.
 * `account` is the row `requireStanding` admitted, set only behind it (null
 * when there is none); `accessOf` is how a route reads it.
 */
export type Caller = CallerClaims;

export type AppEnv = {
	Variables: {
		caller: Caller;
		subject: UsageSubject;
		reading: AccountReading;
		account: Account | null;
	};
};
