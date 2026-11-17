/**
 * A pinned model version expires, and nothing in an apply says so: the
 * deployment resource stays valid, it is the calls that start failing. So
 * every version main.parameters.json pins must be in model-deprecations.json
 * with the retirement date Azure has announced, or `unknown` and the date
 * somebody looked; from thirty days before a listed date the build fails
 * unless an acknowledgement carries a plan and an `until` at most sixty days
 * out. Pins live only in the parameter file, so the file is read as JSON.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INFRA = new URL(".", import.meta.url).pathname;
const WARN_DAYS = 30;
const MAX_ACK_DAYS = 60;

type Entry = {
	model: string;
	version: string;
	inferenceDeprecated: string;
	checked: string;
	acknowledged?: { until: string; why: string };
};

const register = JSON.parse(
	readFileSync(join(INFRA, "model-deprecations.json"), "utf8"),
) as { models: Entry[] };

const parameters = JSON.parse(
	readFileSync(join(INFRA, "main.parameters.json"), "utf8"),
) as {
	parameters: {
		models: { value: Record<string, { model: string; version: string }> };
	};
};

/** What the parameter file pins. */
const pins = Object.entries(parameters.parameters.models.value).map(
	([role, d]) => ({
		role,
		key: `${d.model}@${d.version}`,
	}),
);

function daysUntil(date: string, today: Date): number {
	return Math.floor((Date.parse(date) - today.getTime()) / 86_400_000);
}

/** The verdict for one entry on one day; pure, so the outcomes are pinned below. */
export function verdict(
	entry: Entry,
	today: Date,
): { ok: true } | { ok: false; why: string } {
	const key = `${entry.model}@${entry.version}`;
	if (entry.inferenceDeprecated === "unknown") return { ok: true };
	if (Number.isNaN(Date.parse(entry.inferenceDeprecated)))
		return { ok: false, why: `${key}: inferenceDeprecated is not a date` };
	const left = daysUntil(entry.inferenceDeprecated, today);
	if (left > WARN_DAYS) return { ok: true };
	const ack = entry.acknowledged;
	if (!ack)
		return {
			ok: false,
			why: `${key} is inference-deprecated ${entry.inferenceDeprecated} (${left} days). Read the live deployment, re-pin the version in main.parameters.json and this register, or add an acknowledgement with a plan and an \`until\`.`,
		};
	const holds = daysUntil(ack.until, today);
	if (Number.isNaN(holds) || holds < 0)
		return {
			ok: false,
			why: `${key}: the acknowledgement expired ${ack.until}; re-pin or renew it with a new plan.`,
		};
	if (holds > MAX_ACK_DAYS)
		return {
			ok: false,
			why: `${key}: an acknowledgement may hold ${MAX_ACK_DAYS} days at most; ${ack.until} is ${holds} away.`,
		};
	if (!ack.why?.trim())
		return {
			ok: false,
			why: `${key}: an acknowledgement needs a plan in \`why\``,
		};
	return { ok: true };
}

test("every role pins a model, so the register has something to hold", () => {
	expect(pins.length).toBeGreaterThanOrEqual(4);
});

test("every pinned model version is in the register", () => {
	const listed = new Set(register.models.map((e) => `${e.model}@${e.version}`));
	const missing = pins
		.filter((p) => !listed.has(p.key))
		.map((p) => `${p.key} (${p.role})`);
	expect(
		missing,
		"add each to model-deprecations.json with its retirement date, or `unknown` and the date you looked",
	).toEqual([]);
});

test("every register entry is still pinned, so the register does not rot", () => {
	const pinned = new Set(pins.map((p) => p.key));
	const stale = register.models.filter(
		(e) => !pinned.has(`${e.model}@${e.version}`),
	);
	expect(stale.map((e) => `${e.model}@${e.version}`)).toEqual([]);
});

test("every entry records when its date was read", () => {
	for (const e of register.models)
		expect(Number.isNaN(Date.parse(e.checked)), `${e.model}@${e.version}`).toBe(
			false,
		);
});

test("no pin is within thirty days of retirement without an acknowledged plan", () => {
	const today = new Date();
	const failing = register.models
		.map((e) => verdict(e, today))
		.filter((v): v is { ok: false; why: string } => !v.ok)
		.map((v) => v.why);
	expect(failing).toEqual([]);
});

test("the verdict's outcomes", () => {
	const base: Entry = {
		model: "m",
		version: "v",
		inferenceDeprecated: "2026-12-01",
		checked: "2026-10-01",
	};
	const far = new Date("2026-10-01");
	const near = new Date("2026-11-15");
	const past = new Date("2026-12-05");
	expect(verdict(base, far).ok).toBe(true);
	expect(verdict(base, near).ok).toBe(false);
	expect(verdict(base, past).ok).toBe(false);
	const acked = { ...base, acknowledged: { until: "2026-12-20", why: "plan" } };
	expect(verdict(acked, near).ok).toBe(true);
	expect(verdict(acked, new Date("2026-12-21")).ok).toBe(false);
	const forever = {
		...base,
		acknowledged: { until: "2027-06-01", why: "plan" },
	};
	expect(verdict(forever, near).ok).toBe(false);
	expect(verdict({ ...base, inferenceDeprecated: "unknown" }, past).ok).toBe(
		true,
	);
});
