import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SearchIndexerClient } from "@azure/search-documents";
import { scopedEnv } from "@platform/test-support";
import { resetSearchClients, setSearchIndexerClient } from "../index/client";
import {
	stagedKnowledgeSettings,
	stagedSettings,
} from "../testing/fake-config";
import { pathOfIndexerKey, runIndexer } from "./run";

/**
 * Waiting for a run, against a service that answers its status as the real
 * one does: the previous result until the new run starts, `inProgress`
 * while it runs, and a 409 to a run asked for while another is running.
 */

let restoreEnv = () => {};
let restoreSettings = () => {};
beforeEach(() => {
	restoreEnv = scopedEnv({
		AZURE_SEARCH_INDEX: undefined,
		AZURE_STORAGE_CONTAINER: undefined,
	});
	restoreSettings = stagedSettings({});
});
afterEach(() => {
	restoreSettings();
	restoreEnv();
	resetSearchClients();
});

type Result = {
	status: string;
	startTime?: Date;
	errors: { key?: string; errorMessage: string }[];
	itemCount: number;
	errorMessage?: string;
};

/** A service whose status answers come from `script`, one per ask, the last repeated. */
function service(script: (Result | undefined)[], runs: (() => void)[] = []) {
	const asked = { status: 0, run: 0 };
	setSearchIndexerClient({
		async getIndexerStatus() {
			const lastResult = script[Math.min(asked.status, script.length - 1)];
			asked.status++;
			return { lastResult };
		},
		async runIndexer() {
			const effect = runs[asked.run];
			asked.run++;
			effect?.();
		},
	} as unknown as SearchIndexerClient);
	return asked;
}

const at = (s: number) => new Date(s * 1000);
const ok = (s: number, more: Partial<Result> = {}): Result => ({
	status: "success",
	startTime: at(s),
	errors: [],
	itemCount: 3,
	...more,
});

test("the run it started is the one it waits for: the previous result is not mistaken for it", async () => {
	const asked = service([
		ok(1),
		ok(1),
		{ status: "inProgress", startTime: at(2), errors: [], itemCount: 0 },
		ok(2, { itemCount: 7 }),
	]);
	expect(await runIndexer({ pollMs: 0 })).toEqual({
		itemCount: 7,
		failures: [],
		succeeded: true,
	});
	expect(asked.run).toBe(1);
});

test("a run already in progress is waited out, and a run asked for meanwhile is asked for again", async () => {
	const conflict = Object.assign(
		new Error("Another indexer invocation is in progress"),
		{
			statusCode: 409,
		},
	);
	const asked = service(
		[
			{ status: "inProgress", startTime: at(1), errors: [], itemCount: 0 },
			ok(1),
			ok(1),
			ok(2),
		],
		[
			() => {
				throw conflict;
			},
		],
	);
	await runIndexer({ pollMs: 0 });
	expect(asked.run).toBe(2);
});

test("a file the run failed comes back by its path in the library container", async () => {
	service([
		undefined,
		ok(1, {
			errors: [
				{
					key: "localId=https://store.blob.core.windows.net/library/handbook/pay%20review.pdf&documentKey=aHR0",
					errorMessage: "Could not crack the document",
				},
			],
		}),
	]);
	expect((await runIndexer({ pollMs: 0 })).failures).toEqual([
		{
			path: "handbook/pay review.pdf",
			named: true,
			message: "Could not crack the document",
		},
	]);
});

test("a run that ended short of success and names failures says so, and a key that names no blob is not taken for one", async () => {
	service([
		undefined,
		ok(1, {
			status: "transientFailure",
			errors: [
				{ key: "", errorMessage: "The skillset did not answer" },
				{
					key: "https://store.blob.core.windows.net/library/guides/van.md",
					errorMessage: "Too large",
				},
			],
		}),
	]);
	expect(await runIndexer({ pollMs: 0 })).toEqual({
		itemCount: 3,
		succeeded: false,
		failures: [
			{ path: "", named: false, message: "The skillset did not answer" },
			{ path: "guides/van.md", named: true, message: "Too large" },
		],
	});
});

test("a run that failed outright is an error, and one that outlives the wait is too", async () => {
	service([
		undefined,
		ok(1, { status: "transientFailure", errorMessage: "quota" }),
	]);
	await expect(runIndexer({ pollMs: 0 })).rejects.toThrow(
		"ended transientFailure: quota",
	);

	restoreSettings = stagedKnowledgeSettings({ indexer: { waitMinutes: 1 } });
	const now = Date.now();
	service([
		undefined,
		{ status: "inProgress", startTime: at(1), errors: [], itemCount: 0 },
	]);
	const clock = Date.now;
	let ticks = 0;
	Date.now = () => now + ticks++ * 30_000;
	try {
		await expect(runIndexer({ pollMs: 0 })).rejects.toThrow(
			"did not finish within 1 minutes",
		);
	} finally {
		Date.now = clock;
	}
});

test("a key that names no blob of the container is reported as it came", () => {
	expect(pathOfIndexerKey("aHR0cHM6Ly9zdG9yZQ")).toBe("aHR0cHM6Ly9zdG9yZQ");
	expect(
		pathOfIndexerKey("https://store.blob.core.windows.net/other/a.pdf"),
	).toBe("https://store.blob.core.windows.net/other/a.pdf");
	expect(
		pathOfIndexerKey("https://store.blob.core.windows.net/library/%E0%A4%A"),
	).toBe("https://store.blob.core.windows.net/library/%E0%A4%A");
});
