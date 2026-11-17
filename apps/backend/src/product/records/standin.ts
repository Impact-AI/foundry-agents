import {
	findRecord,
	isRecordKind,
	type SampleRecord,
	searchRecords,
} from "../sample/records";
import { type ProjectItem, statusLabel } from "./project-mapping";

/**
 * A stand-in for the business system `records/http.ts` reads, in one of two
 * shapes:
 *
 * - `sample` (the default): the sample's records under the system's own
 *   names, with a rule on who may see what — a customer only to someone in
 *   the customers group. `recordMapping` (`mapping.ts`) reads it.
 * - `projects`: a project API shaped unlike the app (`project-mapping.ts`
 *   reads it): 200 projects everybody may see and one only its reader group
 *   may, with amounts in minor units, dates, statuses and empty values.
 *
 * Both answer a listing a page at a time — `limit` up to 50, `cursor` from
 * the previous page's `next` — as the adapter expects. The tests run against
 * it, and so can a backend running locally:
 *
 *   bun apps/backend/src/product/records/standin.ts [port] [sample|projects] [host]
 *
 * then `RECORDS_API_URL=http://localhost:<port>` for the backend
 * (docs/worked-example.md). It listens on 127.0.0.1 unless `host` says
 * otherwise: `0.0.0.0` in a container, so another container can reach it.
 *
 * Search is the system's own: the adapter passes `q` through, and each
 * system decides what it matches. The project API matches the number, the
 * customer, the status (its code or its words) and the delivery date by its
 * ISO prefix, so `2027-01` finds what delivers in that month.
 *
 * It is no model of a real system's security: it trusts the caller headers
 * from anyone, where the real one trusts them only from the backend's
 * identity.
 */

/** The group a caller must be in to see a customer. */
export const CUSTOMERS_GROUP = "records-customers";

/** The group a caller must be in to see the restricted project. */
export const EXECUTIVES_GROUP = "records-executives";

/** The project only {@link EXECUTIVES_GROUP} may see. */
export const RESTRICTED_PROJECT = "P-9001";

/** The most a page holds, whatever `limit` asks. */
const PAGE_MAX = 50;

export type StandInSystem = "sample" | "projects";

export interface RecordsStandIn {
	url: string;
	/** Every request it answered: the path, the cursor and the caller headers, for tests. */
	seen: {
		path: string;
		oid: string | null;
		groups: string | null;
		cursor?: string | null;
	}[];
	stop(): void;
}

/** One project as the project API keeps it: its own fields, and who may read it (empty: everybody). */
type StoredProject = ProjectItem & { reader_groups: string[] };

/**
 * The project API's projects: `count` everybody may read and one only
 * {@link EXECUTIVES_GROUP} may. The first has no delivery date, the third
 * no budget, the seventh is kept in yen and every tenth in euros; a few are
 * on hold or closed.
 */
function standInProjects(count = 200): StoredProject[] {
	const projects: StoredProject[] = [];
	for (let i = 1; i <= count; i++) {
		projects.push({
			project_number: `P-${String(i).padStart(4, "0")}`,
			customer_name: i % 2 ? "Acme" : "Example Manufacturing",
			budget_minor: i === 3 ? null : i === 7 ? 15_000_000 : 12_500_000 + i,
			currency: i === 7 ? "JPY" : i % 10 === 0 ? "EUR" : "USD",
			delivery_date:
				i === 1 ? null : `2027-${String((i % 12) + 1).padStart(2, "0")}-15`,
			status: i % 40 === 0 ? "closed" : i % 25 === 0 ? "on_hold" : "active",
			reader_groups: [],
		});
	}
	projects.push({
		project_number: RESTRICTED_PROJECT,
		customer_name: "Restricted Holdings",
		budget_minor: 99_000_000,
		currency: "USD",
		delivery_date: null,
		status: "active",
		reader_groups: [EXECUTIVES_GROUP],
	});
	return projects;
}

function mayReadSample(record: SampleRecord, groups: readonly string[]) {
	return record.kind !== "customer" || groups.includes(CUSTOMERS_GROUP);
}

function mayReadProject(project: StoredProject, groups: readonly string[]) {
	return (
		project.reader_groups.length === 0 ||
		project.reader_groups.some((g) => groups.includes(g))
	);
}

/** The record as the sample-shaped system answers it: its own names, not the sample's. */
function sampleItem(record: SampleRecord) {
	return {
		type: record.kind,
		key: record.id,
		title: record.name,
		attributes: record.fields.map((f) => ({ name: f.label, value: f.value })),
		related: record.links.map((l) => ({ type: l.kind, key: l.id })),
		quarterly: record.figures,
	};
}

interface System {
	find(kind: string, id: string, groups: readonly string[]): unknown | null;
	search(
		kind: string | null,
		query: string | null,
		groups: readonly string[],
	): unknown[];
}

function sampleSystem(): System {
	return {
		find(kind, id, groups) {
			const record = isRecordKind(kind) ? findRecord(kind, id) : null;
			return record && mayReadSample(record, groups)
				? sampleItem(record)
				: null;
		},
		search: (kind, query, groups) =>
			searchRecords(isRecordKind(kind) ? kind : null, query)
				.filter((r) => mayReadSample(r, groups))
				.map(sampleItem),
	};
}

function projectSystem(count: number): System {
	const projects = standInProjects(count);
	return {
		find(kind, id, groups) {
			const project =
				kind === "project"
					? projects.find((p) => p.project_number === id)
					: undefined;
			return project && mayReadProject(project, groups) ? project : null;
		},
		search(kind, query, groups) {
			if (kind && kind !== "project") return [];
			const needle = query?.trim().toLowerCase() ?? "";
			return projects.filter(
				(p) =>
					mayReadProject(p, groups) &&
					(!needle ||
						p.delivery_date?.startsWith(needle) ||
						[
							p.project_number,
							p.customer_name ?? "",
							p.status,
							statusLabel(p.status),
						].some((v) => v.toLowerCase().includes(needle))),
			);
		},
	};
}

export function startRecordsStandIn(
	options: {
		port?: number;
		/** The address it listens on; 127.0.0.1 by default, `0.0.0.0` to be reached from outside a container. */
		hostname?: string;
		/** Added before every answer, for the deadline's tests. */
		delayMs?: number;
		system?: StandInSystem;
		/** How many open projects the `projects` system holds; 200 by default. */
		projects?: number;
	} = {},
): RecordsStandIn {
	const seen: RecordsStandIn["seen"] = [];
	const system =
		options.system === "projects"
			? projectSystem(options.projects ?? 200)
			: sampleSystem();
	const hostname = options.hostname ?? "127.0.0.1";
	const server = Bun.serve({
		port: options.port ?? 0,
		hostname,
		async fetch(request) {
			const url = new URL(request.url);
			const oid = request.headers.get("x-caller-oid");
			const groupsHeader = request.headers.get("x-caller-groups");
			const cursor = url.searchParams.get("cursor");
			seen.push({
				path: url.pathname,
				oid,
				groups: groupsHeader,
				...(cursor ? { cursor } : {}),
			});
			if (options.delayMs) await Bun.sleep(options.delayMs);
			// Nobody verified sees what everybody may.
			const groups = oid ? (groupsHeader ?? "").split(",") : [];
			const [, top, kind, id] = url.pathname.split("/");
			if (top !== "records") return new Response(null, { status: 404 });
			if (kind && id) {
				const found = system.find(kind, decodeURIComponent(id), groups);
				return found
					? Response.json(found)
					: new Response(null, { status: 404 });
			}
			const items = system.search(
				url.searchParams.get("kind"),
				url.searchParams.get("q"),
				groups,
			);
			const asked = Number(url.searchParams.get("limit"));
			const limit =
				Number.isInteger(asked) && asked > 0
					? Math.min(asked, PAGE_MAX)
					: PAGE_MAX;
			// The cursor is an offset here; to the adapter it is an opaque token.
			const offset = Number(cursor ?? 0) || 0;
			const end = offset + limit;
			return Response.json({
				items: items.slice(offset, end),
				next: end < items.length ? String(end) : null,
			});
		},
	});
	return {
		// Every address is reached on the loopback from this machine.
		url: `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${server.port}`,
		seen,
		stop: () => server.stop(true),
	};
}

/** The command line's `[port] [sample|projects] [host]`, each with its default. */
export function standInArgs(args: readonly string[]) {
	return {
		port: Number(args[0] ?? 4400),
		system: (args[1] === "projects" ? "projects" : "sample") as StandInSystem,
		hostname: args[2] ?? "127.0.0.1",
	};
}

if (import.meta.main) {
	const { port, system, hostname } = standInArgs(process.argv.slice(2));
	const standIn = startRecordsStandIn({ port, system, hostname });
	console.log(
		system === "projects"
			? `records stand-in (project API) on ${standIn.url}: ${RESTRICTED_PROJECT} only to the group ${EXECUTIVES_GROUP}`
			: `records stand-in on ${standIn.url}: customers only to the group ${CUSTOMERS_GROUP}`,
	);
}
