import { z } from "zod";
import type { SampleRecord } from "../sample/records";
import type { RecordMapping } from "./mapping";

/**
 * A worked mapping for a system that is not shaped like the app: a project
 * API with its own field names, amounts in minor units, dates as ISO
 * strings, empty values as `null`, and status codes. One project becomes
 * one `project` record, its fields in words a person reads:
 *
 *   { "project_number": "P-0001", "customer_name": "Acme",
 *     "budget_minor": 12500000, "currency": "USD",
 *     "delivery_date": null, "status": "on_hold",
 *     "reader_groups": ["delivery"] }
 *
 * becomes `P-0001 (Acme)` with Customer "Acme", Budget "USD 125,000.00",
 * Delivery date "Not provided" and Status "On hold". `reader_groups` is the
 * system's to enforce, so it is read by no one here (the schema drops it).
 * `standin.ts` serves this API with `system: "projects"`; point
 * `recordMapping` (`mapping.ts`) here to read it.
 */

/** What a field the system holds no value for reads as: said as missing, never as a zero or an empty line. */
export const NOT_PROVIDED = "Not provided";

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine(
		(d) => {
			const time = Date.parse(`${d}T00:00:00Z`);
			// A day the month does not have (February 30) is no date, however it parses.
			return !Number.isNaN(time) && new Date(time).toISOString().startsWith(d);
		},
		{ message: "a calendar date" },
	);

const project = z.object({
	project_number: z.string().min(1).max(40),
	customer_name: z.string().min(1).max(200).nullable(),
	/** In the currency's minor unit (cents for USD and EUR, yen for JPY): an integer, so no amount is rounded on the wire. */
	budget_minor: z.number().int().safe().nullable(),
	currency: z.string().regex(/^[A-Z]{3}$/),
	delivery_date: isoDate.nullable(),
	status: z.string().min(1).max(40),
});

export type ProjectItem = z.infer<typeof project>;

/** The status codes the system answers, in words; one it adds later reads as its code in words. */
const STATUSES: Record<string, string> = {
	active: "Active",
	on_hold: "On hold",
	closed: "Closed",
};

export function statusLabel(code: string): string {
	const words = code.replaceAll("_", " ").toLowerCase();
	return STATUSES[code] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** An amount in minor units as the currency writes it: `USD 125,000.00`, `JPY 15,000,000`. */
export function displayAmount(minor: number | null, currency: string): string {
	if (minor === null) return NOT_PROVIDED;
	const format = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency,
		currencyDisplay: "code",
	});
	// The currency's own exponent: two decimals for USD, none for JPY.
	const exponent = format.resolvedOptions().maximumFractionDigits ?? 2;
	return format.format(minor / 10 ** exponent).replace(/\s/g, " ");
}

/** A calendar date as a person reads it: US English, the month in words, then the day and the year. */
export function displayDate(iso: string | null): string {
	if (iso === null) return NOT_PROVIDED;
	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "long",
		timeZone: "UTC",
	}).format(new Date(`${iso}T00:00:00Z`));
}

/**
 * A project's line in a listing: what "which projects deliver in…" or
 * "which are on hold" is answered from. The customer is already in the
 * name, so the line leaves it out.
 */
export const PROJECT_SUMMARY_FIELDS = [
	"Status",
	"Delivery date",
	"Budget",
] as const;

export const projectMapping: RecordMapping<ProjectItem> = {
	schema: project,
	toRecord: (p): SampleRecord => ({
		kind: "project",
		id: p.project_number,
		name: p.customer_name
			? `${p.project_number} (${p.customer_name})`
			: p.project_number,
		fields: [
			{ label: "Customer", value: p.customer_name ?? NOT_PROVIDED },
			{ label: "Budget", value: displayAmount(p.budget_minor, p.currency) },
			{ label: "Delivery date", value: displayDate(p.delivery_date) },
			{ label: "Status", value: statusLabel(p.status) },
		],
		summaryFields: PROJECT_SUMMARY_FIELDS,
		// The API names its customer, not a record of it, and keeps no quarterly figures.
		links: [],
		figures: {},
	}),
};
