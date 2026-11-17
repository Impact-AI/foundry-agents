import { afterAll, beforeAll, expect, test } from "bun:test";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import {
	createThreadDocument,
	indexContainers,
	markBlocked,
	nameUntitledThread,
	readThreadDocument,
	setThreadTitle,
} from "./threads";

/**
 * The thread's name as the host writes it: only while there is none, so
 * two writers racing to name one thread leave one name, and a name the
 * person gave stands.
 */

let cosmos: TestCosmos;
const who = "account-named";

beforeAll(async () => {
	cosmos = await openTestCosmos(indexContainers);
});

afterAll(async () => {
	await cosmos.drop();
});

async function thread(threadId: string): Promise<void> {
	await createThreadDocument({
		resourceId: who,
		threadId,
		title: "",
		history: {},
	});
}

test("two writers naming one thread leave the first one's name, and the second learns it lost", async () => {
	await thread("thread-raced");
	const named = await Promise.all([
		nameUntitledThread(who, "thread-raced", "Old maps"),
		nameUntitledThread(who, "thread-raced", "New maps"),
	]);
	expect(named.filter(Boolean)).toHaveLength(1);
	const title = (await readThreadDocument(who, "thread-raced"))?.title;
	expect(title).toBe(named[0] ? "Old maps" : "New maps");
});

test("a name the person gave is never overwritten, and a thread that is gone is not named", async () => {
	await thread("thread-chosen");
	await setThreadTitle(who, "thread-chosen", "Chosen by hand");
	expect(await nameUntitledThread(who, "thread-chosen", "Old maps")).toBe(
		false,
	);
	expect((await readThreadDocument(who, "thread-chosen"))?.title).toBe(
		"Chosen by hand",
	);
	expect(await nameUntitledThread(who, "thread-none", "Old maps")).toBe(false);
});

test("two writers marking one thread's messages blocked at once both keep their entries", async () => {
	await thread("thread-blocked");
	await Promise.all([
		markBlocked(who, "thread-blocked", ["a.1", "a.2"]),
		markBlocked(who, "thread-blocked", ["b.1"]),
	]);
	const blocked = (await readThreadDocument(who, "thread-blocked"))?.blocked;
	expect([...(blocked ?? [])].sort()).toEqual(["a.1", "a.2", "b.1"]);
});
