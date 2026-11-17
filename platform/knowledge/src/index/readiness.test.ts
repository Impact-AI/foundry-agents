import { afterEach, beforeEach, expect, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import { fakeSearchClient } from "../testing/fake-search";
import { resetSearchClients } from "./client";
import { checkChunkIndex, SearchIndexUnavailableError } from "./readiness";

/** How the SDK throws a refused request: a `RestError` carrying the status. */
const answered = (statusCode: number, message: string) =>
	Object.assign(new Error(message), { name: "RestError", statusCode });

let restoreEnv = () => {};

beforeEach(() => {
	restoreEnv = scopedEnv({
		AZURE_SEARCH_ENDPOINT: "https://search.test",
		AZURE_SEARCH_INDEX: undefined,
	});
});

afterEach(() => {
	restoreEnv();
	resetSearchClients();
});

test("no search service named is knowledge search off, and nothing is asked", async () => {
	process.env.AZURE_SEARCH_ENDPOINT = "";
	fakeSearchClient().countFailure = answered(500, "never asked");
	expect(await checkChunkIndex()).toBe("unconfigured");
});

test("an index that answers is present", async () => {
	fakeSearchClient();
	expect(await checkChunkIndex()).toBe("present");
});

test("an absent index is the job's to make, and is waited for rather than made", async () => {
	fakeSearchClient().countFailure = answered(
		404,
		"No index with the name 'chunks' was found",
	);
	expect(await checkChunkIndex()).toBe("awaiting-index");
});

test("a service that refuses the serving identity's own role is misconfiguration, and refuses the start", async () => {
	fakeSearchClient().countFailure = answered(403, "Forbidden");
	const check = checkChunkIndex();
	await expect(check).rejects.toBeInstanceOf(SearchIndexUnavailableError);
	await expect(check).rejects.toThrow(/"chunks".*Forbidden/);
});

test("a service that cannot be reached refuses the start", async () => {
	fakeSearchClient().countFailure = new Error(
		"getaddrinfo ENOTFOUND search.test",
	);
	await expect(checkChunkIndex()).rejects.toThrow(/ENOTFOUND/);
});
