import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { AgentHost } from "@platform/agent";
import { openTestCosmos, type TestCosmos } from "@platform/cosmos/testing";
import { identityContainers } from "@platform/identity";
import { exportResponse } from "./export";

let cosmos: TestCosmos;
beforeAll(async () => {
	cosmos = await openTestCosmos(identityContainers);
});
afterAll(async () => {
	await cosmos.drop();
});

test("a read that fails once the copy has begun fails the download and is reported, never ended as a whole file", async () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	const log = spyOn(console, "log").mockImplementation(() => {});
	const host = {
		readMemory: async () => ({ items: [] }),
		listThreads: async () => {
			throw new Error("the thread index did not answer");
		},
	} as unknown as AgentHost;
	try {
		const response = exportResponse(host, "account-export");
		expect(response.status).toBe(200);
		await expect(response.text()).rejects.toThrow(
			"the thread index did not answer",
		);
		expect(error).toHaveBeenCalledTimes(1);
		const reported = log.mock.calls.map((call) => String(call[0]));
		expect(
			reported.some((line) => line.includes("backend.export.incomplete")),
		).toBe(true);
	} finally {
		error.mockRestore();
		log.mockRestore();
	}
});
