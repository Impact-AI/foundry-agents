/**
 * The sample's records: a dozen fictional people, projects, customers and
 * assets, with the fields an enterprise directory would hold and eight
 * quarters of figures each. Everything here is invented so the record tools
 * and the stage have something to show; a product replaces this module
 * with its own store and keeps the shapes.
 */

export type RecordKind = "person" | "project" | "customer" | "asset";

export const RECORD_KINDS: readonly RecordKind[] = [
	"person",
	"project",
	"customer",
	"asset",
];

export interface RecordField {
	label: string;
	value: string;
}

export interface RecordLink {
	kind: RecordKind;
	id: string;
}

/** A figure tracked per quarter: what it is called, what it is measured in, and how quarters roll into a year. */
export interface Measure {
	key: string;
	unit: string;
	aggregate: "sum" | "mean";
}

export interface SampleRecord {
	kind: RecordKind;
	id: string;
	name: string;
	fields: RecordField[];
	links: RecordLink[];
	/** One value per entry of {@link QUARTERS}, keyed by measure. */
	figures: Record<string, readonly number[]>;
	/**
	 * The labels of the fields a listing's one line carries, in order: what
	 * the model can filter and answer from without opening each record. Unset,
	 * the line carries the first two fields. A mapping sets it
	 * (`records/mapping.ts`) when the fields a question asks about are not first.
	 */
	summaryFields?: readonly string[];
}

/** The quarters every figure is kept for, oldest first. */
export const QUARTERS = [
	"2024-Q1",
	"2024-Q2",
	"2024-Q3",
	"2024-Q4",
	"2025-Q1",
	"2025-Q2",
	"2025-Q3",
	"2025-Q4",
] as const;

export const MEASURES: Record<RecordKind, readonly Measure[]> = {
	person: [
		{ key: "billableHours", unit: "hours", aggregate: "sum" },
		{ key: "utilisation", unit: "%", aggregate: "mean" },
	],
	project: [
		{ key: "spend", unit: "kEUR", aggregate: "sum" },
		{ key: "openIssues", unit: "issues", aggregate: "mean" },
	],
	customer: [
		{ key: "revenue", unit: "kEUR", aggregate: "sum" },
		{ key: "supportTickets", unit: "tickets", aggregate: "sum" },
	],
	asset: [
		{ key: "uptime", unit: "%", aggregate: "mean" },
		{ key: "runningCost", unit: "kEUR", aggregate: "sum" },
	],
};

const field = (label: string, value: string): RecordField => ({ label, value });
const link = (kind: RecordKind, id: string): RecordLink => ({ kind, id });

export const SAMPLE_RECORDS: readonly SampleRecord[] = [
	{
		kind: "person",
		id: "mara-lindqvist",
		name: "Mara Lindqvist",
		fields: [
			field("Role", "Programme lead"),
			field("Department", "Operations"),
			field("Location", "Gothenburg"),
			field("Joined", "2021-03"),
		],
		links: [
			link("project", "ledger-migration"),
			link("project", "field-tablet-rollout"),
		],
		figures: {
			billableHours: [410, 432, 388, 455, 470, 448, 402, 466],
			utilisation: [72, 76, 68, 80, 83, 79, 71, 82],
		},
	},
	{
		kind: "person",
		id: "tobias-achterberg",
		name: "Tobias Achterberg",
		fields: [
			field("Role", "Solutions engineer"),
			field("Department", "Delivery"),
			field("Location", "Rotterdam"),
			field("Joined", "2019-09"),
		],
		links: [link("project", "warehouse-vision"), link("asset", "data-hall-2")],
		figures: {
			billableHours: [455, 460, 440, 470, 480, 490, 465, 475],
			utilisation: [80, 81, 77, 83, 85, 86, 82, 84],
		},
	},
	{
		kind: "person",
		id: "ines-valverde",
		name: "Inés Valverde",
		fields: [
			field("Role", "Account manager"),
			field("Department", "Sales"),
			field("Location", "Madrid"),
			field("Joined", "2022-01"),
		],
		links: [
			link("customer", "halvard-logistics"),
			link("customer", "brightmoor-clinics"),
			link("customer", "oakline-retail"),
		],
		figures: {
			billableHours: [300, 310, 295, 330, 340, 335, 320, 350],
			utilisation: [55, 57, 54, 61, 63, 62, 59, 65],
		},
	},
	{
		kind: "project",
		id: "ledger-migration",
		name: "Ledger Migration",
		fields: [
			field("Status", "In progress"),
			field("Phase", "Data cut-over"),
			field("Budget", "480 kEUR"),
			field("Started", "2024-02"),
			field("Planned end", "2026-03"),
		],
		links: [
			link("person", "mara-lindqvist"),
			link("customer", "oakline-retail"),
		],
		figures: {
			spend: [38, 52, 61, 70, 74, 69, 66, 58],
			openIssues: [12, 19, 27, 24, 18, 15, 11, 9],
		},
	},
	{
		kind: "project",
		id: "field-tablet-rollout",
		name: "Field Tablet Rollout",
		fields: [
			field("Status", "Completed"),
			field("Phase", "Closed"),
			field("Budget", "210 kEUR"),
			field("Started", "2024-01"),
			field("Ended", "2025-06"),
		],
		links: [
			link("person", "mara-lindqvist"),
			link("customer", "halvard-logistics"),
			link("asset", "delivery-fleet"),
		],
		figures: {
			spend: [22, 35, 41, 39, 33, 28, 0, 0],
			openIssues: [8, 14, 16, 11, 6, 2, 0, 0],
		},
	},
	{
		kind: "project",
		id: "warehouse-vision",
		name: "Warehouse Vision",
		fields: [
			field("Status", "In progress"),
			field("Phase", "Pilot"),
			field("Budget", "350 kEUR"),
			field("Started", "2025-01"),
			field("Planned end", "2026-09"),
		],
		links: [
			link("person", "tobias-achterberg"),
			link("customer", "halvard-logistics"),
			link("asset", "data-hall-2"),
		],
		figures: {
			spend: [0, 0, 0, 0, 18, 31, 44, 47],
			openIssues: [0, 0, 0, 0, 5, 13, 17, 14],
		},
	},
	{
		kind: "customer",
		id: "halvard-logistics",
		name: "Halvard Logistics",
		fields: [
			field("Sector", "Logistics"),
			field("Region", "Nordics"),
			field("Tier", "Enterprise"),
			field("Customer since", "2019"),
		],
		links: [
			link("person", "ines-valverde"),
			link("project", "field-tablet-rollout"),
			link("project", "warehouse-vision"),
		],
		figures: {
			revenue: [310, 325, 318, 342, 356, 371, 364, 389],
			supportTickets: [41, 38, 45, 36, 33, 29, 31, 27],
		},
	},
	{
		kind: "customer",
		id: "brightmoor-clinics",
		name: "Brightmoor Clinics",
		fields: [
			field("Sector", "Healthcare"),
			field("Region", "United Kingdom"),
			field("Tier", "Mid-market"),
			field("Customer since", "2023"),
		],
		links: [link("person", "ines-valverde")],
		figures: {
			revenue: [84, 90, 95, 101, 108, 112, 117, 125],
			supportTickets: [12, 15, 11, 9, 14, 10, 8, 7],
		},
	},
	{
		kind: "customer",
		id: "oakline-retail",
		name: "Oakline Retail",
		fields: [
			field("Sector", "Retail"),
			field("Region", "Iberia"),
			field("Tier", "Enterprise"),
			field("Customer since", "2020"),
		],
		links: [
			link("person", "ines-valverde"),
			link("project", "ledger-migration"),
		],
		figures: {
			revenue: [240, 236, 251, 268, 262, 275, 281, 294],
			supportTickets: [30, 34, 28, 25, 27, 22, 20, 19],
		},
	},
	{
		kind: "asset",
		id: "data-hall-2",
		name: "Data Hall 2",
		fields: [
			field("Type", "Facility"),
			field("Location", "Rotterdam"),
			field("Capacity", "1.2 MW"),
			field("Commissioned", "2022-05"),
		],
		links: [
			link("person", "tobias-achterberg"),
			link("project", "warehouse-vision"),
		],
		figures: {
			uptime: [99.91, 99.95, 99.88, 99.97, 99.96, 99.93, 99.98, 99.97],
			runningCost: [142, 139, 151, 147, 144, 150, 158, 153],
		},
	},
	{
		kind: "asset",
		id: "delivery-fleet",
		name: "Delivery Fleet",
		fields: [
			field("Type", "Vehicles"),
			field("Units", "48 vans"),
			field("Base", "Gothenburg"),
			field("Average age", "3.4 years"),
		],
		links: [link("project", "field-tablet-rollout")],
		figures: {
			uptime: [93.5, 94.1, 92.8, 95.2, 95.9, 96.3, 95.4, 96.8],
			runningCost: [88, 91, 97, 94, 90, 93, 99, 96],
		},
	},
	{
		kind: "asset",
		id: "analytics-licence-pool",
		name: "Analytics Licence Pool",
		fields: [
			field("Type", "Software licences"),
			field("Seats", "350"),
			field("Renewal", "2026-04"),
			field("Owner", "Operations"),
		],
		links: [link("person", "mara-lindqvist")],
		figures: {
			uptime: [100, 99.9, 100, 100, 99.8, 100, 100, 100],
			runningCost: [61, 61, 61, 64, 64, 64, 64, 67],
		},
	},
];

export function isRecordKind(value: unknown): value is RecordKind {
	return (
		typeof value === "string" && RECORD_KINDS.includes(value as RecordKind)
	);
}

export function findRecord(kind: RecordKind, id: string): SampleRecord | null {
	return SAMPLE_RECORDS.find((r) => r.kind === kind && r.id === id) ?? null;
}

/** Records of one kind, or every kind, whose name or a field contains the query, case-insensitively. */
export function searchRecords(
	kind: RecordKind | null,
	query?: string | null,
): SampleRecord[] {
	const needle = query?.trim().toLowerCase() ?? "";
	return SAMPLE_RECORDS.filter(
		(r) =>
			(!kind || r.kind === kind) &&
			(!needle ||
				r.name.toLowerCase().includes(needle) ||
				r.fields.some((f) => f.value.toLowerCase().includes(needle))),
	);
}

/** What a kind's records keep figures of, as the card and the tools name them: the key `metrics` takes and its unit. */
function measuresOf(kind: RecordKind): { key: string; unit: string }[] {
	return MEASURES[kind].map(({ key, unit }) => ({ key, unit }));
}

/** The measures of its kind a record keeps figures for: a system may keep none of some, or none at all. */
export function measuresKept(
	record: Pick<SampleRecord, "kind" | "figures">,
): { key: string; unit: string }[] {
	return measuresOf(record.kind).filter((m) => m.key in record.figures);
}

/** The record as one line of a listing. */
export interface RecordSummary {
	kind: RecordKind;
	id: string;
	name: string;
	summary: string;
}

/** The fields a listing's line carries when the record names none: its first two. */
const SUMMARY_DEFAULT = 2;

export function recordSummary(record: SampleRecord): RecordSummary {
	const fields = record.summaryFields
		? record.summaryFields.flatMap((label) =>
				record.fields.filter((f) => f.label === label),
			)
		: record.fields.slice(0, SUMMARY_DEFAULT);
	return {
		kind: record.kind,
		id: record.id,
		name: record.name,
		summary: fields.map((f) => `${f.label}: ${f.value}`).join(" · "),
	};
}
