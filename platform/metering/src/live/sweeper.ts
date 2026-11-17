import {
	envInt,
	failureReason,
	processSingleton,
	resetSingleton,
} from "@platform/config";
import { getRedis, isRedisConfigured } from "@platform/redis";
import { keys } from "../keys";
import { reportHangup, reportUnavailable } from "../report";
import { parseRecord } from "./record";
import { CLAIM_DUE } from "./scripts";
import { ENDED_NOTE_TTL_SECONDS, type Settlement, settle } from "./session";

/**
 * The cutoff. Not a per-request timer: every replica ticks, pops due
 * sessions by the server's clock with one atomic claim, asks the provider to
 * hang each up, and settles it at its deadline — a sweeper that ran late
 * does not owe a refund for its own lateness. The cutoff depends on no
 * replica in particular, no cooperative client, and no request arriving.
 *
 * Claim before hangup: a replica that dies between the two loses one hangup
 * for one session and the charge stands. The other order would let two
 * replicas hang up, or hang up a session its browser already ended.
 */

/** What the provider answered a hangup with, for the line the sweeper prints. */
export interface HangupResult {
	status: number;
}

/**
 * Asks the provider to end `callId`. Meant never to throw; the ledger is
 * settled whatever it says, and when it throws all the same: the session is
 * already claimed, so nothing else would ever settle it.
 */
export type Hangup = (callId: string) => Promise<HangupResult>;

/** Most sessions one sweep ends. A bound, not a target: the rest wait for the next tick, or the next replica. */
const SWEEP_BATCH = 50;

/** The status printed for a hangup that threw rather than answered. */
const HANGUP_THREW = 0;

export async function sweepDueSessions(hangup: Hangup): Promise<Settlement[]> {
	const redis = await getRedis();
	if (!redis) return [];
	const settled: Settlement[] = [];
	for (let i = 0; i < SWEEP_BATCH; i++) {
		let popped: unknown;
		try {
			popped = await redis.send("EVAL", [
				CLAIM_DUE,
				"4",
				keys.deadlines(),
				keys.sessionPrefix(),
				keys.endedPrefix(),
				keys.lockPrefix(),
				String(ENDED_NOTE_TTL_SECONDS),
			]);
		} catch (err) {
			reportUnavailable(err);
			break;
		}
		if (!Array.isArray(popped) || popped.length === 0) break;
		const [id, ...fields] = popped;
		const record = parseRecord(String(id), fields);
		if (!record) continue;
		let status = HANGUP_THREW;
		try {
			status = (await hangup(record.callId)).status;
		} catch (err) {
			console.error(
				`[metering] the hangup of session ${record.id} threw; settling it all the same:`,
				failureReason(err),
			);
		}
		reportHangup({
			session: record.id,
			status,
			lateMs: Math.max(0, Date.now() - record.deadlineAt),
		});
		settled.push(await settle(record, record.deadlineAt));
	}
	return settled;
}

export const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

/** How often each replica looks: a few seconds late on a cutoff is invisible, a tight loop on a shared server is not. */
export function sweepIntervalMs(): number {
	return envInt("METERING_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS, {
		min: 250,
	});
}

const SINGLETON = "metering:sweeper";

interface Ticker {
	timer: ReturnType<typeof setInterval>;
	sweeping: boolean;
}

/**
 * Start the ticker for this process, once; a second call is a no-op. Unref'd
 * so it never holds a process open, and re-entrancy guarded so a slow tick
 * is skipped rather than stacked. Without Redis there is nothing to sweep
 * and nothing starts. Returns the stop.
 */
export function startSweeper(options: {
	hangup: Hangup;
	intervalMs?: number;
}): () => void {
	if (!isRedisConfigured()) return () => {};
	processSingleton<Ticker>(SINGLETON, () => {
		const ticker: Ticker = {
			sweeping: false,
			timer: setInterval(() => {
				if (ticker.sweeping) return;
				ticker.sweeping = true;
				void sweepDueSessions(options.hangup)
					.catch((err) => reportUnavailable(err))
					.finally(() => {
						ticker.sweeping = false;
					});
			}, options.intervalMs ?? sweepIntervalMs()),
		};
		ticker.timer.unref?.();
		return ticker;
	});
	return stopSweeper;
}

export function stopSweeper(): void {
	const ticker = processSingleton<Ticker | null>(SINGLETON, () => null);
	if (ticker) clearInterval(ticker.timer);
	resetSingleton(SINGLETON);
}
