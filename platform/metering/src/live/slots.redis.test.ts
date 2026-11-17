import { expect, test } from "bun:test";
import { REDIS_AVAILABLE } from "../testing/real-server";
import {
	freshSubject,
	meteredSuite,
	recorded,
	TOY_LIMITS,
} from "../testing/suite";
import { renewSession, settleSession } from "./session";
import { liveCapacity, liveSessionCount } from "./slots";

/** The concurrent-session cap against a real server: what holds a slot, and for how long. */

const t = test.skipIf(!REDIS_AVAILABLE);
meteredSuite({
	...TOY_LIMITS,
	realtime: { ...TOY_LIMITS.realtime, concurrentSessions: 1 },
});

t(
	"a recorded session holds a slot until its deadline, a renewal moves it, and a settle frees it",
	async () => {
		const who = freshSubject("slot");
		const started = Date.now();
		// Four seconds bought under a twenty-second ceiling; a renewal three
		// seconds in buys a fresh ten-second window, nine seconds on.
		const id = await recorded({
			subject: who,
			callId: "rtc_slot",
			startedAt: started,
			debitedSeconds: 4,
			hardSeconds: 20,
			ownDay: true,
		});
		expect(await liveSessionCount(started)).toBe(1);
		expect(await liveSessionCount(started + 5_000)).toBe(0);
		const full = await liveCapacity(started);
		expect(full).toMatchObject({ full: true, live: 1, capacity: 1 });
		if (full.full) {
			expect(full.retryAfterSeconds).toBeGreaterThanOrEqual(30);
			expect(full.retryAfterSeconds).toBeLessThan(60);
		}
		expect(await liveCapacity(started + 5_000)).toEqual({
			full: false,
			live: 0,
			capacity: 1,
		});
		// A session still talking must not read as a free slot.
		expect(await renewSession(id, who, "base", started + 3_000)).toEqual({
			ok: true,
			deadlineAt: started + 13_000,
			boughtSeconds: 9,
		});
		expect(await liveSessionCount(started + 5_000)).toBe(1);
		await settleSession(id, who, started + 5_000);
		expect(await liveSessionCount(started)).toBe(0);
	},
);
