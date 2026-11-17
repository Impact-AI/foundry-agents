import { azureCredential, createEntraTokenProvider } from "@platform/config";
import { z } from "zod";
import type { SampleRecord } from "../sample/records";
import {
	type RecordsCaller,
	type RecordsListing,
	type RecordsSource,
	RecordsUnavailable,
} from "./contract";
import { type RecordMapping, recordMapping } from "./mapping";

/**
 * The records from a business system over HTTP: the calls, and the mapping
 * (`mapping.ts`) from the system's own shape to the one the tools and the
 * stage read.
 *
 * The system is called as the backend — its managed identity's token for
 * `RECORDS_API_SCOPE`, no key — and told who is asking in two headers it
 * trusts only from that identity: `X-Caller-Oid` and `X-Caller-Groups`. It
 * answers only what that person may see, and answers a record they may not
 * see as it answers one that does not exist.
 *
 * Two requests, under the base URL:
 *
 *   GET /records/{kind}/{id}              one record, or 404
 *   GET /records?kind=&q=&limit=&cursor=  { "items": [...], "next": "…" }
 *
 * A listing is followed page by page while the system answers a `next`,
 * which goes back as `cursor`, until it answers none or the listing reaches
 * {@link LIST_MAX}. A system that does not page answers one page with no
 * `next`, and that is the whole listing.
 *
 * One deadline covers a whole question: the token, every page's request and
 * every body. A system that is slow, down or answers something else is a
 * `RecordsUnavailable`, never a hung turn.
 */

const DEADLINE_MS = 5000;

/** Asked of the system per page, as `limit`. It may answer fewer, or ignore it. */
export const PAGE_SIZE = 50;

/**
 * The most records one listing gathers. A listing becomes one tool answer in
 * the model's context and one list on the stage: 500 one-line summaries is
 * about as much as either is useful with, and as much as a system answering
 * pages of 50 serves inside the deadline. Past it, the listing says it is
 * partial and the model asks the person to narrow the question.
 */
export const LIST_MAX = 500;

/** The most pages one listing reads, so a system answering short or empty pages with a `next` still stops. */
export const PAGES_MAX = 20;

const listing = z.object({
	items: z.array(z.unknown()),
	next: z.string().min(1).max(2000).nullish(),
});

export interface HttpRecordsOptions<T> {
	/** The system's base URL; `/records` is under it. */
	url: string;
	/** The `.default` scope of the system's app registration; unset sends no token (a stand-in running locally). */
	scope?: string;
	deadlineMs?: number;
	/** The bearer, for tests; the default mints the process identity's token for `scope`. */
	bearer?: () => Promise<string>;
	/** The system's record to the app's; the default is `recordMapping`. */
	mapping?: RecordMapping<T>;
}

export function httpRecordsSource<T = unknown>(
	options: HttpRecordsOptions<T>,
): RecordsSource {
	const base = options.url.replace(/\/+$/, "");
	const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
	const mapping = (options.mapping ??
		recordMapping) as unknown as RecordMapping<T>;
	const bearer =
		options.bearer ??
		(options.scope
			? createEntraTokenProvider({
					credential: azureCredential,
					scope: options.scope,
				})
			: null);

	/** One question to the system: every request it makes shares one deadline and one token. */
	function question(caller: RecordsCaller | null) {
		const signal = AbortSignal.timeout(deadlineMs);
		const bounded = <V>(work: Promise<V>) =>
			new Promise<V>((resolve, reject) => {
				signal.throwIfAborted();
				const abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				work
					.then(resolve, reject)
					.finally(() => signal.removeEventListener("abort", abort));
			});
		let token: Promise<string> | null = null;

		return async function get(path: string): Promise<unknown> {
			const headers: Record<string, string> = { Accept: "application/json" };
			if (caller) {
				headers["X-Caller-Oid"] = caller.oid;
				headers["X-Caller-Groups"] = caller.groups.join(",");
			}
			try {
				if (bearer) {
					token ??= bearer();
					headers.Authorization = `Bearer ${await bounded(token)}`;
				}
				const response = await fetch(`${base}${path}`, { headers, signal });
				if (response.status === 404) return null;
				if (!response.ok)
					throw new RecordsUnavailable(
						`The records system answered ${response.status}.`,
					);
				return await bounded(response.json());
			} catch (error) {
				if (error instanceof RecordsUnavailable) throw error;
				throw new RecordsUnavailable(
					error instanceof Error && error.name === "TimeoutError"
						? `The records system did not answer within ${deadlineMs} ms.`
						: "The records system could not be reached.",
				);
			}
		};
	}

	/** One record through the mapping, or null when it is not one. */
	function mapped(raw: unknown): SampleRecord | null {
		const parsed = mapping.schema.safeParse(raw);
		return parsed.success ? mapping.toRecord(parsed.data) : null;
	}

	return {
		async find(kind, id, caller) {
			const body = await question(caller)(
				`/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
			);
			if (body === null) return null;
			const record = mapped(body);
			if (!record)
				throw new RecordsUnavailable(
					"The records system answered something that is not a record.",
				);
			return record;
		},
		async search(kind, query, caller): Promise<RecordsListing> {
			const get = question(caller);
			const notListing = () =>
				new RecordsUnavailable(
					"The records system answered something that is not a listing.",
				);
			const records: SampleRecord[] = [];
			let cursor: string | null = null;
			for (let page = 1; ; page++) {
				const params = new URLSearchParams();
				if (kind) params.set("kind", kind);
				if (query) params.set("q", query);
				params.set("limit", String(PAGE_SIZE));
				if (cursor) params.set("cursor", cursor);
				const parsed = listing.safeParse(await get(`/records?${params}`));
				if (!parsed.success) throw notListing();
				const { items, next } = parsed.data;
				const room = LIST_MAX - records.length;
				// Only what fits is mapped: the rest of a page past the bound is not read.
				for (const raw of items.slice(0, room)) {
					const record = mapped(raw);
					if (!record) throw notListing();
					records.push(record);
				}
				if (items.length > room) return { records, truncated: true };
				if (!next) return { records, truncated: false };
				if (records.length >= LIST_MAX || page >= PAGES_MAX)
					return { records, truncated: true };
				cursor = next;
			}
		},
	};
}
