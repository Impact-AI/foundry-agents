import type { CallerRefusal } from "@platform/agent";
import {
	ACCOUNT_ERASED,
	type AccountAccess,
	type AccountReading,
	accountAccess,
	readAccountStanding,
	standingRefusal,
} from "@platform/identity";
import type { CallerAccess } from "@platform/knowledge";
import type { Context, MiddlewareHandler } from "hono";
import { problems } from "../problems";
import { refuse } from "../routes/reply";
import { callerGateOpen } from "./caller";
import type { AppEnv } from "./context";

/**
 * The one read of the caller's row a request makes, shared by the two gates
 * below. No session stands behind an open gate, so none can be the one an
 * erase ended: what the erase of its one account left reads there as no
 * account yet, and a checkout is never shut out of itself. A deactivation
 * an erase left is a deactivation there too.
 */
export async function readingOf(c: Context<AppEnv>): Promise<AccountReading> {
	const held = c.get("reading");
	if (held) return held;
	const reading = await readNow(c);
	c.set("reading", reading);
	return reading;
}

/** The caller's row as it is now, read as the gate reads it. */
async function readNow(c: Context<AppEnv>): Promise<AccountReading> {
	const { sub, signedInAt } = c.get("caller");
	const read = await readAccountStanding(sub, { signedInAt });
	return read.standing === "erased" && callerGateOpen()
		? { standing: read.deactivated ? "deactivated" : "active", account: null }
		: read;
}

/**
 * The rule every write a request makes later than its gate keeps: it lands
 * only while the account is still the one the gate admitted the request
 * on. A request is admitted on one read of the row, then its body is read —
 * which a slow upload, or a client that holds it, can stretch past an erase
 * and past the sign-in that made a new account of the id. So a write of
 * the account's row names the account the gate read
 * (`@platform/identity`'s `AdmittedAccount`), and a turn or a live session
 * asks this once it is counted as running and before it writes anything:
 * the row read again, as the gate reads it, and refused unless its standing
 * still admits the request and it is the same account — told by when it
 * was made, which only an erase and the sign-in after one change. An erase
 * shuts the row before it ends the person's turns, so a turn either is
 * counted in time for the erase to end it, or finds the row shut here.
 *
 * One point read; failing closed, as the gate does. Only behind the gate.
 */
export function stillAdmitted(
	c: Context<AppEnv>,
): () => Promise<CallerRefusal | null> {
	const admitted = c.get("reading");
	if (!admitted)
		throw new Error(
			"stillAdmitted is asked behind the gate, which reads the row",
		);
	return async () => {
		const now = await readNow(c);
		const refusal: CallerRefusal | null =
			standingRefusal(now.standing) ?? anotherAccount(admitted, now);
		if (refusal)
			problems.report("backend.account.standing", {
				status: refusal.status,
				reason: refusal.code,
			});
		return refusal;
	};
}

/**
 * Whether the row now holds an account other than the one a request was
 * admitted on: erased since, or made again by the sign-in after an erase —
 * told by when the account was made, which only an erase and the sign-in
 * after one change. A row that cannot be read is no answer, so it refuses.
 */
function anotherAccount(
	admitted: AccountReading,
	now: AccountReading,
): CallerRefusal | null {
	if (now.standing === "unknown") return standingRefusal("unknown");
	if (now.standing === "erased") return standingRefusal("erased");
	return (now.account?.createdAt ?? null) ===
		(admitted.account?.createdAt ?? null)
		? null
		: { status: 401, code: ACCOUNT_ERASED };
}

/** A write the request made later than its gate found the account gone from under it: the session is over, as the gate would now say. */
export function refuseAccountGone(c: Context<AppEnv>) {
	problems.report("backend.account.standing", {
		status: 401,
		reason: ACCOUNT_ERASED,
	});
	return refuse(c, 401, ACCOUNT_ERASED);
}

/** Where a web app reports a sign-in: the one call that turns what an erase left into a new account. */
const SIGN_IN_PATH = "/identity/sign-in";

/** The warm-up reads and writes nothing of a person, so it asks for no row. */
const WARM_PATH = "/warm";

/** Where a person asks for their own erasure. */
const ERASE_PATH = "/account";

/**
 * On every route but the sign-in report and the warm-up: a session that
 * began before its account was erased is over. It is the erased person's,
 * the id may by now be a new account's, and nothing it asks is read or
 * written under it — 401, so the web app signs the browser out. That holds
 * for what the erase of a deactivated account left as well: no route is
 * kept, the rights routes included, so nothing is written back onto a row
 * emptied of its person.
 *
 * The one thing such a session may still do is ask for the erase again
 * while the row is only what an erase left or is leaving: the answer to
 * the first ask may have been lost, or the erase may have stopped part
 * way. The route finishes one that had not finished, and answers one that
 * had the same way, touching nothing (`routes/account`). Once somebody has
 * signed in under the id it is refused like everything else.
 *
 * A row that cannot be read refuses the request, 503: which of the two a
 * session is cannot be told without it, and a guess would let the erased
 * person's session read, edit or erase the account made after them. It
 * costs every gated request one point read of the caller's row, which the
 * routes that spend share (`readingOf`).
 */
export const refuseErasedSession: MiddlewareHandler<AppEnv> = async (
	c,
	next,
) => {
	if (c.req.path === SIGN_IN_PATH || c.req.path === WARM_PATH) return next();
	const reading = await readingOf(c);
	if (reading.standing !== "erased" && reading.standing !== "unknown")
		return next();
	if (
		reading.standing === "erased" &&
		reading.remade === false &&
		c.req.method === "DELETE" &&
		c.req.path === ERASE_PATH
	)
		return next();
	const refusal = standingRefusal(reading.standing);
	if (!refusal) return next();
	problems.report("backend.account.standing", {
		status: refusal.status,
		reason: refusal.code,
	});
	return refuse(c, refusal.status, refusal.code);
};

/** The methods that change nothing: their answer is read before anything could be written. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The second half of the gate, for every request that may write: judged
 * again once its body has arrived, not when its headers did. A request is
 * admitted on one read of the account's row, and a client that holds its
 * body — or a slow upload — stretches the time to its first write past an
 * erase and past the sign-in that makes a new account of the id. So the
 * body is read whole here, within the bound before this, and the row is
 * read again: a request whose account is no longer the one it was admitted
 * on is refused, `401 account_erased`, before any route sees it, and one
 * whose row cannot be read is refused 503, as the gate refuses. What the
 * route then writes follows at once, with nothing left to wait for from
 * the client.
 *
 * Every route but the two with a rule of their own: the sign-in report,
 * which is what makes the new account, and the erase, which a session from
 * before it may ask again and which writes only against the row it read
 * (`routes/account`). A deactivated account is the same account: its rights
 * routes stay open, and the routes that spend refuse it themselves.
 *
 * One more point read for each request that may write; the routes after it
 * read the row this read.
 */
export const judgedOnArrival: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (READS.has(c.req.method) || c.req.path === SIGN_IN_PATH) return next();
	if (c.req.raw.body) {
		const body = await c.req.raw.arrayBuffer();
		c.req.raw = new Request(c.req.raw, {
			body: body.byteLength ? body : null,
		});
	}
	if (c.req.method === "DELETE" && c.req.path === ERASE_PATH) return next();
	const admitted = await readingOf(c);
	const now = await readNow(c);
	const refusal = anotherAccount(admitted, now);
	if (refusal) {
		problems.report("backend.account.standing", {
			status: refusal.status,
			reason: refusal.code,
		});
		return refuse(c, refusal.status, refusal.code);
	}
	c.set("reading", now);
	return next();
};

/**
 * The session carries a snapshot; anything that costs something re-asks the
 * database at the point of use. One read of the account's row per request,
 * uncached, failing closed: its standing decides whether the request may
 * spend, and the same row is what the tier and the groups are read from
 * (`accessOf`) — never the assertion, which carries what the provider said at
 * sign-in. So a deactivation reaches the next spend, and a role or group the
 * provider took away reaches it as soon as a sign-in has recorded that,
 * which the frontend's bounded session forces within hours.
 */
export const requireStanding: MiddlewareHandler<AppEnv> = async (c, next) => {
	const { standing, account } = await readingOf(c);
	const refusal = standingRefusal(standing);
	if (refusal) {
		problems.report("backend.account.standing", {
			status: refusal.status,
			reason: refusal.code,
		});
		return refuse(c, refusal.status, refusal.code);
	}
	c.set("account", account);
	await next();
};

/** What the account gets, from the row the gate read. No row is the lesser answer. Only behind `requireStanding`. */
export function accessOf(c: Context<AppEnv>): AccountAccess {
	const account = c.get("account");
	if (account === undefined)
		throw new Error("accessOf is read behind requireStanding, which sets it");
	return accountAccess(account);
}

/**
 * Who is asking, as the knowledge base's readers rule reads it: the verified
 * subject and the groups the account's row holds, never a parameter. Only
 * behind `requireStanding`.
 */
export function callerAccess(c: Context<AppEnv>): CallerAccess {
	return { oid: c.get("caller").sub, groups: accessOf(c).groups };
}
