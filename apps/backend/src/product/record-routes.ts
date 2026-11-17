import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth/context";
import { callerAccess, requireStanding } from "../auth/standing";
import { NO_STORE, refuse } from "../routes/reply";
import { type RecordsCaller, RecordsUnavailable } from "./records/contract";
import { recordCard, recordsSource } from "./records/source";
import type { Period } from "./sample/metrics";
import { isRecordKind } from "./sample/records";
import { listRecords } from "./tools/list-records";
import { metrics } from "./tools/metrics";

const QUERY_MAX = 120;
const MEASURE_MAX = 40;

const isPeriod = (value: unknown): value is Period =>
	value === "quarter" || value === "year";

/** Who is asking, from the account the standing gate read: what the source decides by. */
const callerOf = (c: Context<AppEnv>): RecordsCaller => callerAccess(c);

/**
 * The records for the stage, by hand: what the agent's `listRecords`,
 * `lookupRecord` and `metrics` answer, through the same functions, the same
 * source and by the same ids, so a list, a card or a chart opened from the
 * interface is the one the agent would have placed. Behind the standing
 * gate, as everything the product serves is: a deactivated account reads no
 * record. The caller is the account the gate read, so a source that decides
 * who may see a record (`records/http.ts`) answers the interface as it
 * answers the agent; a source that cannot answer is a 503.
 */
export function recordRoutes(): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();
	routes.use("*", requireStanding);
	routes.onError((error, c) => {
		if (error instanceof RecordsUnavailable)
			return refuse(c, 503, "unavailable");
		throw error;
	});

	routes.get("/", async (c) => {
		const kind = c.req.query("kind");
		if (kind !== undefined && !isRecordKind(kind))
			return refuse(c, 400, "invalid_query");
		const query = c.req.query("query")?.trim() ?? "";
		if (query.length > QUERY_MAX) return refuse(c, 400, "invalid_query");
		return c.json(
			await listRecords({ kind, ...(query ? { query } : {}) }, callerOf(c)),
			200,
			NO_STORE,
		);
	});

	routes.get("/:kind/:id", async (c) => {
		const kind = c.req.param("kind");
		if (!isRecordKind(kind)) return refuse(c, 404, "not_found");
		const caller = callerOf(c);
		const source = recordsSource();
		const record = await source.find(kind, c.req.param("id"), caller);
		if (!record) return refuse(c, 404, "not_found");
		return c.json(await recordCard(source, record, caller), 200, NO_STORE);
	});

	routes.get("/:kind/:id/metrics/:measure", async (c) => {
		const kind = c.req.param("kind");
		if (!isRecordKind(kind)) return refuse(c, 404, "not_found");
		const period = c.req.query("period") ?? "quarter";
		if (!isPeriod(period)) return refuse(c, 400, "invalid_query");
		const measure = c.req.param("measure");
		if (measure.length > MEASURE_MAX) return refuse(c, 404, "not_found");
		const answer = await metrics(
			{ record: { kind, id: c.req.param("id") }, measure, period },
			callerOf(c),
		);
		if (!answer.found)
			return answer.measures.length
				? refuse(c, 404, "no_such_measure", { measures: answer.measures })
				: refuse(c, 404, "not_found");
		return c.json(answer, 200, NO_STORE);
	});

	return routes;
}
