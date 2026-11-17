import type { AgentHost } from "@platform/agent";
import {
	ACCOUNT_ERASED,
	ErasedSessionError,
	eraseUnderWay,
} from "@platform/identity";
import { Hono } from "hono";
import { callerGateOpen } from "../auth/caller";
import type { AppEnv } from "../auth/context";
import { readingOf } from "../auth/standing";
import { EraseBusyError, eraseAccount } from "../erasure";
import { exportResponse } from "../export";
import { problems } from "../problems";
import { refuse } from "./reply";

/**
 * The person's rights over what the product holds: a copy, and erasure.
 * Neither asks standing — deactivation shuts the product, not the rights —
 * and neither takes a parameter: the account is the caller's own. The
 * rights do not reopen the product either: a deactivated account's erasure
 * leaves the deactivation standing (`../erasure`), and ends the account's
 * sessions as any erasure does.
 *
 * An erase that stops part way, whatever stopped it — the service or the
 * cache refusing, a check finding something left — is incomplete: reported
 * as such for the operator, and a 503 for the person. Its first write has
 * shut the row, so nothing is made under the id while it stands unfinished,
 * and every step is idempotent: asking again sweeps again and finishes
 * what the first attempt left. The gate lets the session that asked, and
 * any other from before the erase, do exactly that and nothing else
 * (`../auth/standing`'s `refuseErasedSession`).
 *
 * Asking while another request is still sweeping the same account starts
 * no second sweep: it waits a moment for that one to finish and answers as
 * it did, or 503 if it has not by then.
 *
 * Asking again after it finished is answered the same 204 and does
 * nothing: there is nothing left to finish, and a sweep run again would run
 * under an id a sign-in may make somebody's new account at any moment. An
 * ask that was already past the gate when another finished is held to the
 * same line where it writes (`../erasure`): it shuts the row only while the
 * row is still that session's own, and sweeps only once it has, so it
 * cannot reach the account a sign-in made in between; it is answered
 * `401 account_erased`, as that session now is everywhere.
 */
/** How long a second ask waits for the erase another request is sweeping, and how often it looks. */
const ERASE_WAIT_MS = 3_000;
const ERASE_LOOK_MS = 100;

/** True once the erase somebody else holds is over; false if it still stands when the wait ends. */
async function eraseOver(accountId: string): Promise<boolean> {
	const until = Date.now() + ERASE_WAIT_MS;
	while (Date.now() < until) {
		if (!(await eraseUnderWay(accountId))) return true;
		await Bun.sleep(ERASE_LOOK_MS);
	}
	return false;
}

export function accountRoutes(host: AgentHost): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.delete("/", async (c) => {
		const reading = await readingOf(c);
		if (reading.standing === "erased" && !reading.erasing)
			return c.body(null, 204);
		const { sub, signedInAt } = c.get("caller");
		try {
			// No session stands behind an open gate, so none is named.
			await eraseAccount(
				host,
				sub,
				callerGateOpen() ? undefined : { signedInAt },
			);
		} catch (err) {
			if (err instanceof EraseBusyError) {
				// Another request is sweeping: when it is done, so is this one.
				if (await eraseOver(sub)) return c.body(null, 204);
				return refuse(c, 503, "erase_incomplete");
			}
			if (err instanceof ErasedSessionError) {
				problems.report("backend.account.standing", {
					status: 401,
					reason: ACCOUNT_ERASED,
				});
				return refuse(c, 401, ACCOUNT_ERASED);
			}
			console.error("[backend] an erase stopped part way:", err);
			problems.report("backend.erase.incomplete", { status: 503 });
			return refuse(c, 503, "erase_incomplete");
		}
		return c.body(null, 204);
	});

	routes.get("/export", (c) => exportResponse(host, c.get("caller").sub));

	return routes;
}
