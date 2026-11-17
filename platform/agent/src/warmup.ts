import { envInt } from "@platform/config";

/**
 * Pay the first turn's cold costs before it: the credential and TLS to the
 * model's origin, the first connection in each pool, the memos every
 * turn's instructions read through. One warm at a time, its result shared,
 * and a completed one trusted for a while — so a public route that calls
 * this costs the process at most one embedding a minute. Every probe
 * failure is logged and swallowed: warming is a favour to the next turn,
 * never a gate in front of it.
 */
export type Probe = [name: string, run: () => Promise<unknown>];

export class Warmer {
	private inflight: Promise<void> | null = null;
	private warmedAt = 0;

	constructor(private readonly probes: () => Probe[]) {}

	warm(): Promise<void> {
		if (this.inflight) return this.inflight;
		if (Date.now() - this.warmedAt < ttlMs()) return Promise.resolve();
		this.inflight = this.run()
			.then(
				(warmed) => {
					// Only a run with something warm is trusted for the while: one that failed whole is tried again.
					if (warmed) this.warmedAt = Date.now();
				},
				(err) => console.error("[warmup] failed:", (err as Error).message),
			)
			.finally(() => {
				this.inflight = null;
			});
		return this.inflight;
	}

	/** Whether any probe succeeded. */
	private async run(): Promise<boolean> {
		const probes = this.probes();
		const t0 = performance.now();
		const results = await Promise.allSettled(probes.map(([, run]) => run()));
		const failed = results.flatMap((r, i) =>
			r.status === "rejected" ? [probes[i]?.[0] ?? "?"] : [],
		);
		console.log(
			`[warmup] done in ${Math.round(performance.now() - t0)}ms${
				failed.length ? ` (failed: ${failed.join(", ")})` : ""
			}`,
		);
		return failed.length < probes.length;
	}
}

function ttlMs(): number {
	return envInt("WARMUP_TTL_MS", 60_000, { min: 0 });
}
