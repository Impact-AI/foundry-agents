import { expect, test } from "bun:test";
import type { UsageSubject } from "../subject";
import {
	endReasonFor,
	parseRecord,
	readEndedNote,
	refundFor,
	renewalGrant,
} from "./record";

const who = "account-1" as UsageSubject;

test("the refund is debited minus used, rounded against the subject, never below zero", () => {
	const record = { startedAt: 1_000_000, debitedSeconds: 10 };
	expect(refundFor(record, 1_004_200)).toEqual({ usedSeconds: 5, refund: 5 });
	expect(refundFor(record, 1_000_000)).toEqual({ usedSeconds: 0, refund: 10 });
	// An end before the start is nothing used, not something odd.
	expect(refundFor(record, 999_000)).toEqual({ usedSeconds: 0, refund: 10 });
	// Past the debit, the whole debit was used and nothing comes back.
	expect(refundFor(record, 1_060_000)).toEqual({ usedSeconds: 10, refund: 0 });
});

test("a renewal buys exactly the whole seconds it moves the deadline by, and never past the ceiling", () => {
	const record = { deadlineAt: 10_000, hardDeadlineAt: 40_000 };
	// Four seconds in on a ten-second window: a fresh window is four ahead.
	expect(renewalGrant(record, 4_000, 10)).toBe(4);
	// Renewed a moment ago: nothing to buy, and no rounded-up second.
	expect(renewalGrant(record, 0, 10)).toBe(0);
	expect(renewalGrant(record, 900, 10)).toBe(0);
	// Near the ceiling only what fits is sold, and at it nothing.
	expect(renewalGrant(record, 35_000, 10)).toBe(30);
	expect(renewalGrant({ ...record, deadlineAt: 40_000 }, 60_000, 10)).toBe(0);
});

test("renewal keeps the invariant every settle depends on", () => {
	const startedAt = 0;
	let record = { deadlineAt: 10_000, hardDeadlineAt: 30_000, debited: 10 };
	for (const now of [4_000, 9_500, 15_000, 20_000, 25_000, 60_000]) {
		const bought = renewalGrant(record, now, 10);
		record = {
			...record,
			deadlineAt: record.deadlineAt + bought * 1000,
			debited: record.debited + bought,
		};
		expect(record.deadlineAt).toBe(startedAt + record.debited * 1000);
		expect(record.deadlineAt).toBeLessThanOrEqual(record.hardDeadlineAt);
	}
	expect(record.deadlineAt).toBe(30_000);
});

test("the end reason is read off the deadline", () => {
	expect(endReasonFor(10_000, 30_000)).toBe("idle");
	expect(endReasonFor(30_000, 30_000)).toBe("length");
	expect(endReasonFor(31_000, 30_000)).toBe("length");
});

test("a record is parsed from a flat field list, and anything short of one is null", () => {
	const flat = [
		"subject",
		who,
		"callId",
		"rtc_1",
		"startedAt",
		"1000",
		"debitedSeconds",
		"10",
		"deadlineAt",
		"11000",
		"hardDeadlineAt",
		"31000",
		"endReason",
		"idle",
		"ownDay",
		"1",
	];
	expect(parseRecord("id-1", flat)).toEqual({
		id: "id-1",
		subject: who,
		callId: "rtc_1",
		startedAt: 1000,
		debitedSeconds: 10,
		deadlineAt: 11000,
		hardDeadlineAt: 31000,
		endReason: "idle",
		ownDay: true,
	});
	expect(parseRecord("id-1", null)).toBeNull();
	// The subject is minted, not copied: one no key could carry is no record.
	const braced = [...flat];
	braced[1] = "{tag}";
	expect(parseRecord("id-1", braced)).toBeNull();
	expect(parseRecord("id-1", [])).toBeNull();
	expect(parseRecord("id-1", flat.slice(0, 14))).toBeNull();
	const odd = [...flat];
	odd[13] = "cutoff";
	expect(parseRecord("id-1", odd)).toBeNull();
	odd[13] = "idle";
	odd[5] = "soon";
	expect(parseRecord("id-1", odd)).toBeNull();
});

test("the note names which cutoff it was, and only to the subject it was about", () => {
	expect(readEndedNote("allowance:account-1", who)).toEqual({
		ended: "allowance",
	});
	expect(readEndedNote("idle:account-1", who)).toEqual({ ended: "idle" });
	expect(readEndedNote("length:account-1", who)).toEqual({ ended: "length" });
	expect(readEndedNote("idle:account-2", who)).toBeNull();
	expect(readEndedNote("cutoff:account-1", who)).toBeNull();
	expect(readEndedNote("account-1", who)).toBeNull();
	expect(readEndedNote(null, who)).toBeNull();
});
