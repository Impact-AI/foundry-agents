import { expect, spyOn, test } from "bun:test";
import { scopedEnv } from "@platform/test-support";
import {
	resetAppConfigClient,
	setAppConfigClient,
} from "./app-configuration/client";
import { defineConfigKey, type SharedCache } from "./config-key";

interface Limits {
	perDay: number;
	burst: number;
}

const DEFAULTS: Limits = { perDay: 100, burst: 10 };

/** Merges over the default; refuses anything that is not a positive integer. */
function parseLimits(stored: unknown, defaults: Limits): Limits {
	const doc = (stored ?? {}) as Record<string, unknown>;
	const positiveInt = (v: unknown, fallback: number) =>
		Number.isInteger(v) && (v as number) > 0 ? (v as number) : fallback;
	return {
		perDay: positiveInt(doc.perDay, defaults.perDay),
		burst: positiveInt(doc.burst, defaults.burst),
	};
}

function key(
	name: string,
	read: (key: string) => Promise<unknown>,
	extra = {},
) {
	return defineConfigKey<Limits>({
		key: name,
		defaultValue: DEFAULTS,
		parse: parseLimits,
		read,
		...extra,
	});
}

test("the stored document is merged over the default, and a wrong-kind field keeps the default", async () => {
	const limits = key("limits-a", async () => ({ perDay: 5, burst: "lots" }));
	expect(await limits.read()).toEqual({ perDay: 5, burst: 10 });
});

test("a store that has never answered serves the default; a failed refresh serves the last good value", async () => {
	let answer: () => Promise<unknown> = async () => {
		throw new Error("unreachable");
	};
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const limits = key("limits-b", () => answer(), { ttlMs: 0 });
		expect(limits.cached()).toEqual(DEFAULTS);
		expect(await limits.read()).toEqual(DEFAULTS);
		answer = async () => ({ perDay: 3 });
		expect(await limits.read()).toEqual({ perDay: 3, burst: 10 });
		answer = async () => {
			throw new Error("unreachable again");
		};
		expect(await limits.read()).toEqual({ perDay: 3, burst: 10 });
		expect(limits.cached()).toEqual({ perDay: 3, burst: 10 });
	} finally {
		warn.mockRestore();
	}
});

test("a checkout with no store serves the default from the default read, and warns nothing", async () => {
	const restore = scopedEnv({ APP_CONFIG_ENDPOINT: undefined });
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const limits = defineConfigKey<Limits>({
			key: "limits-no-store",
			defaultValue: DEFAULTS,
			parse: parseLimits,
			ttlMs: 0,
		});
		expect(await limits.read()).toEqual(DEFAULTS);
		expect(await limits.read()).toEqual(DEFAULTS);
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
		restore();
	}
});

test("a client a test injected is a store, endpoint or not", async () => {
	const restore = scopedEnv({ APP_CONFIG_ENDPOINT: undefined });
	setAppConfigClient({
		async getConfigurationSetting() {
			return { value: JSON.stringify({ perDay: 7 }) };
		},
	} as unknown as Parameters<typeof setAppConfigClient>[0]);
	try {
		const limits = defineConfigKey<Limits>({
			key: "limits-injected",
			defaultValue: DEFAULTS,
			parse: parseLimits,
		});
		expect(await limits.read()).toEqual({ perDay: 7, burst: 10 });
	} finally {
		resetAppConfigClient();
		restore();
	}
});

test("a read within the TTL does not touch the origin, and concurrent misses share one read", async () => {
	let reads = 0;
	const limits = key("limits-c", async () => {
		reads++;
		return { perDay: 1 };
	});
	await Promise.all([limits.read(), limits.read(), limits.read()]);
	await limits.read();
	expect(reads).toBe(1);
	limits.invalidate();
	await limits.read();
	expect(reads).toBe(2);
});

test("two definitions of one store key keep their own memo: neither serves the other's parsed shape", async () => {
	const perDay = key("limits-shared-name", async () => ({ perDay: 5 }));
	const burst = defineConfigKey<{ burst: number }>({
		key: "limits-shared-name",
		defaultValue: { burst: 1 },
		parse: (stored) => ({
			burst: ((stored ?? {}) as { burst?: number }).burst ?? 1,
		}),
		read: async () => ({ burst: 9 }),
	});
	expect(await perDay.read()).toEqual({ perDay: 5, burst: 10 });
	expect(await burst.read()).toEqual({ burst: 9 });
	expect(perDay.cached()).toEqual({ perDay: 5, burst: 10 });
	expect(burst.cached()).toEqual({ burst: 9 });
});

test("a shared cache answers for the fleet, and only an origin answer is written to it", async () => {
	const held = new Map<string, { value: unknown; at: number }>();
	const shared: SharedCache = {
		read: async (k) => (held.get(k) as { value: never; at: number }) ?? null,
		write: async (k, value) => {
			held.set(k, { value, at: Date.now() });
		},
	};
	let reads = 0;
	const limits = key(
		"limits-d",
		async () => {
			reads++;
			return { burst: 2 };
		},
		{ shared, ttlMs: 0 },
	);
	expect(await limits.read()).toEqual({ perDay: 100, burst: 2 });
	expect(held.get("limits-d")?.value).toEqual({ burst: 2 });
	expect(await limits.read()).toEqual({ perDay: 100, burst: 2 });
	expect(reads).toBe(1);
});

test("a refresh that failed over a held value is not asked again within the pace, and is once the pace has passed", async () => {
	let reads = 0;
	let down = false;
	let now = 1_000_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const limits = key(
			"limits-paced",
			async () => {
				reads++;
				if (down) throw new Error("unreachable");
				return { burst: 3 };
			},
			{ ttlMs: 10_000 },
		);
		const held = { perDay: 100, burst: 3 };
		expect(await limits.read()).toEqual(held);
		down = true;
		now += 10_001;
		for (let i = 0; i < 5; i++) expect(await limits.read()).toEqual(held);
		expect(reads).toBe(2);
		expect(warn).toHaveBeenCalledTimes(1);
		now += 5_001;
		expect(await limits.read()).toEqual(held);
		expect(reads).toBe(3);
		// An invalidation asks at once, pace or not.
		limits.invalidate();
		await limits.read();
		expect(reads).toBe(4);
	} finally {
		clock.mockRestore();
		warn.mockRestore();
	}
});

test("with nothing held a failed read is one read and one warning for the callers of a fifth of a second, and the store is asked again after it", async () => {
	let reads = 0;
	let down = true;
	let now = 3_000_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const limits = key("limits-cold", async () => {
			reads++;
			await Bun.sleep(5);
			if (down) throw new Error("unreachable");
			return { burst: 4 };
		});
		// Callers that arrive together share the one read, and it warns once.
		const together = await Promise.all(
			Array.from({ length: 50 }, () => limits.read()),
		);
		expect(together.every((value) => value === DEFAULTS)).toBe(true);
		expect(reads).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
		// Callers one after another, inside the pace: the default, no read, no warning.
		for (let i = 0; i < 50; i++) expect(await limits.read()).toEqual(DEFAULTS);
		expect(reads).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
		// Past it the store is asked, and its value served once it is back.
		now += 201;
		expect(await limits.read()).toEqual(DEFAULTS);
		expect(reads).toBe(2);
		expect(warn).toHaveBeenCalledTimes(2);
		down = false;
		now += 201;
		expect(await limits.read()).toEqual({ perDay: 100, burst: 4 });
		expect(reads).toBe(3);
	} finally {
		clock.mockRestore();
		warn.mockRestore();
	}
});

test("a read an invalidation overtook writes nothing to the cache every replica reads", async () => {
	const held = new Map<string, { value: unknown; at: number }>();
	const shared: SharedCache = {
		async read<T>(name: string) {
			return (held.get(name) as { value: T; at: number } | undefined) ?? null;
		},
		async write(name, value) {
			held.set(name, { value, at: Date.now() });
		},
	};
	let stored = { burst: 1 };
	let release: () => void = () => {};
	let parked = false;
	const limits = key(
		"limits-overtaken",
		async () => {
			const seen = stored;
			if (!parked) {
				parked = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return seen;
		},
		{ shared, ttlMs: 60_000 },
	);
	const overtaken = limits.read();
	await Bun.sleep(1);
	// The document changes, the shared copy is cleared and the key invalidated, all while that read waits.
	stored = { burst: 2 };
	held.delete("limits-overtaken");
	limits.invalidate();
	release();
	expect(await overtaken).toEqual({ perDay: 100, burst: 1 });
	expect(held.has("limits-overtaken")).toBe(false);
	expect(await limits.read()).toEqual({ perDay: 100, burst: 2 });
	expect(held.get("limits-overtaken")?.value).toEqual({ burst: 2 });
	expect(limits.cached()).toEqual({ perDay: 100, burst: 2 });
});

test("a read in flight when the key is invalidated changes nothing held: its failure sets no pace and its value is not kept", async () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	let now = 2_000_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	try {
		const answers: Array<() => Promise<unknown>> = [];
		const gates: Array<() => void> = [];
		const limits = key(
			"limits-stale",
			() => {
				const answer = answers.shift();
				if (!answer) throw new Error("no answer scripted");
				return new Promise((resolve, reject) => {
					gates.push(() => answer().then(resolve, reject));
				});
			},
			{ ttlMs: 60_000 },
		);

		// A read that will fail is overtaken by an invalidation; the read after it is served by the store.
		answers.push(
			async () => {
				throw new Error("unreachable");
			},
			async () => ({ burst: 5 }),
		);
		const overtaken = limits.read();
		limits.invalidate();
		const fresh = limits.read();
		await Bun.sleep(1);
		gates[1]?.();
		expect(await fresh).toEqual({ perDay: 100, burst: 5 });
		gates[0]?.();
		expect(await overtaken).toEqual(DEFAULTS);
		expect(limits.cached()).toEqual({ perDay: 100, burst: 5 });
		// The overtaken failure set no pace: once the memo has expired the store is asked.
		now += 60_001;
		answers.push(async () => ({ burst: 8 }));
		const afterExpiry = limits.read();
		await Bun.sleep(1);
		gates[2]?.();
		expect(await afterExpiry).toEqual({ perDay: 100, burst: 8 });

		// A read that answers the old value after an invalidation is not what the memo holds.
		limits.invalidate();
		answers.push(
			async () => ({ burst: 6 }),
			async () => ({ burst: 7 }),
		);
		const old = limits.read();
		await Bun.sleep(1);
		limits.invalidate();
		const next = limits.read();
		await Bun.sleep(1);
		gates[4]?.();
		expect(await next).toEqual({ perDay: 100, burst: 7 });
		gates[3]?.();
		expect(await old).toEqual({ perDay: 100, burst: 6 });
		expect(limits.cached()).toEqual({ perDay: 100, burst: 7 });
	} finally {
		clock.mockRestore();
		warn.mockRestore();
	}
});
