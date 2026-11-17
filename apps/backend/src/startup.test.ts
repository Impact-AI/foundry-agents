import {
	afterEach,
	beforeEach,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import {
	type CosmosAccess,
	CosmosStatusError,
	closeCosmos,
	setCosmosDatabase,
} from "@platform/cosmos";
import { startWhenAdmitted } from "./startup";

let warn: Mock<typeof console.warn>;
let log: Mock<typeof console.log>;
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
	log = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	warn.mockRestore();
	log.mockRestore();
});

function answers(...sequence: CosmosAccess[]) {
	let asked = 0;
	return {
		check: async () =>
			sequence[Math.min(asked++, sequence.length - 1)] as CosmosAccess,
		asked: () => asked,
	};
}

test("a role not yet applied is waited out with one warning, and the host starts once it is admitted", async () => {
	const database = answers("awaiting-roles", "awaiting-roles", "admitted");
	let starts = 0;
	const startup = startWhenAdmitted(async () => void starts++, {
		check: database.check,
		retryMs: 1,
	});
	const running = startup.run();
	expect(startup.ready()).toBe(false);
	await running;
	expect(database.asked()).toBe(3);
	expect(starts).toBe(1);
	expect(startup.ready()).toBe(true);
	expect(warn).toHaveBeenCalledTimes(1);
});

test("an admitted identity starts at once and says nothing", async () => {
	const startup = startWhenAdmitted(async () => {}, {
		check: answers("admitted").check,
	});
	await startup.run();
	expect(startup.ready()).toBe(true);
	expect(warn).not.toHaveBeenCalled();
	expect(log).not.toHaveBeenCalled();
});

test("any other failure is a failed start, and the host is never started", async () => {
	let starts = 0;
	const startup = startWhenAdmitted(async () => void starts++, {
		check: async () => {
			throw new Error("connection timeout");
		},
	});
	await expect(startup.run()).rejects.toThrow("connection timeout");
	expect(starts).toBe(0);
	expect(startup.ready()).toBe(false);
});

test("a host that fails to start is not ready", async () => {
	const startup = startWhenAdmitted(
		async () => {
			throw new Error("storage init failed");
		},
		{ check: answers("admitted").check },
	);
	await expect(startup.run()).rejects.toThrow("storage init failed");
	expect(startup.ready()).toBe(false);
});

test("by default, a Cosmos DB role not yet applied is waited out, and a Cosmos DB that fails otherwise fails the start", async () => {
	let refusals = 0;
	setCosmosDatabase({
		container: () => {
			throw new Error("not reached");
		},
		verify: async () => {
			refusals += 1;
			throw new CosmosStatusError(refusals < 3 ? 403 : 503, "refused");
		},
	});
	let starts = 0;
	try {
		const startup = startWhenAdmitted(async () => void starts++, {
			retryMs: 1,
		});
		await expect(startup.run()).rejects.toThrow("refused");
		expect(refusals).toBe(3);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(starts).toBe(0);
	} finally {
		closeCosmos();
	}
});

test("a service refusing the host's start is waited out as Cosmos DB is, and the start is asked again", async () => {
	let starts = 0;
	const startup = startWhenAdmitted(
		async () => {
			starts += 1;
			if (starts < 3)
				throw new Error("the index could not be read", {
					cause: Object.assign(new Error("Forbidden"), { statusCode: 403 }),
				});
		},
		{ check: answers("admitted").check, retryMs: 1 },
	);
	await startup.run();
	expect(starts).toBe(3);
	expect(startup.ready()).toBe(true);
	expect(warn).toHaveBeenCalledTimes(1);
});

test("a data plane that answers a role not yet applied with 401 and a missing permission is waited out; a bare 401 is a failed start", async () => {
	const lagging = [
		Object.assign(
			new Error("Principal does not have access to API/Operation."),
			{
				status: 401,
				code: "PermissionDenied",
			},
		),
		Object.assign(new Error("Unauthorized"), {
			statusCode: 401,
			error: { code: "PermissionDenied" },
		}),
		new Error("the host could not start", {
			cause: Object.assign(new Error("401 PermissionDenied"), { status: 401 }),
		}),
	];
	let asked = 0;
	const startup = startWhenAdmitted(
		async () => {
			const refusal = lagging[asked++];
			if (refusal) throw refusal;
		},
		{ check: answers("admitted").check, retryMs: 1 },
	);
	await startup.run();
	expect(asked).toBe(lagging.length + 1);
	expect(startup.ready()).toBe(true);

	// A token nobody accepts, or one for another audience or tenant: no wait mends it, however it is worded.
	for (const unaccepted of [
		Object.assign(new Error("Unauthorized"), {
			status: 401,
			code: "InvalidAuthenticationToken",
		}),
		Object.assign(
			new Error(
				"The request is not authorized: the token's audience is incorrect.",
			),
			{ status: 401, code: "Unauthorized" },
		),
		Object.assign(new Error("Unauthorized"), {
			statusCode: 401,
			error: {
				code: "401",
				message:
					"Access denied due to invalid tenant. The caller is not authorized for this resource.",
			},
		}),
	]) {
		let attempts = 0;
		const refused = startWhenAdmitted(
			async () => {
				attempts++;
				throw unaccepted;
			},
			// Short, so that waiting on it would end as a refusal that outlasted the wait, not as this one.
			{ check: answers("admitted").check, retryMs: 1, waitMs: 50 },
		);
		await expect(refused.run()).rejects.toBe(unaccepted);
		expect(attempts).toBe(1);
		expect(refused.ready()).toBe(false);
	}
});

test("a refusal that outlasts the wait is a failed start, from Cosmos DB or from the host's own", async () => {
	const never = startWhenAdmitted(async () => {}, {
		check: answers("awaiting-roles").check,
		retryMs: 1,
		waitMs: 5,
	});
	await expect(never.run()).rejects.toThrow("Cosmos DB still refuses");
	expect(never.ready()).toBe(false);

	const refused = startWhenAdmitted(
		async () => {
			throw Object.assign(new Error("Forbidden"), { status: 403 });
		},
		{ check: answers("admitted").check, retryMs: 1, waitMs: 5 },
	);
	await expect(refused.run()).rejects.toThrow("still refuses this identity");
	expect(refused.ready()).toBe(false);
});
