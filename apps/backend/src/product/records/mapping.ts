import { z } from "zod";
import {
	RECORD_KINDS,
	type RecordKind,
	type SampleRecord,
} from "../sample/records";

/**
 * The one place the business system's record becomes the app's: a schema
 * for one record as the system answers it, and the function from that to a
 * `SampleRecord`, the shape the tools, the card and the chart read. The
 * adapter (`http.ts`) owns the calls — the paths, the paging, the headers,
 * the deadline — and hands every record it receives to the mapping, so a
 * team connecting its own system writes a mapping and leaves the adapter as
 * it is. A record that fails the schema is an answer that is not records:
 * the tools say the system is unavailable rather than show half a record.
 */
export interface RecordMapping<T> {
	/** One record as the system answers it, in its own names. */
	schema: z.ZodType<T, unknown>;
	/**
	 * That record as the app's. Its `summaryFields` names the fields a
	 * listing's one line carries to the model, which answers "which…"
	 * questions from those lines alone; unset, the first two.
	 */
	toRecord(item: T): SampleRecord;
}

const kind = z.enum(RECORD_KINDS as [RecordKind, ...RecordKind[]]);
const text = z.string().min(1).max(200);

/**
 * The stand-in's own format: the sample's records under other names
 * (`type`, `key`, `title`, `attributes`, `related`, `quarterly`), mapped one
 * to one. It is what `standin.ts` serves by default.
 */
const sampleItem = z.object({
	type: kind,
	key: text,
	title: text,
	attributes: z
		.array(z.object({ name: text, value: z.string().max(400) }))
		.max(20),
	related: z.array(z.object({ type: kind, key: text })).max(20),
	quarterly: z.record(z.string().max(40), z.array(z.number()).max(40)),
});

const sampleShapeMapping: RecordMapping<z.infer<typeof sampleItem>> = {
	schema: sampleItem,
	toRecord: (it) => ({
		kind: it.type,
		id: it.key,
		name: it.title,
		fields: it.attributes.map((a) => ({ label: a.name, value: a.value })),
		links: it.related.map((r) => ({ kind: r.type, id: r.key })),
		figures: it.quarterly,
	}),
};

/**
 * The mapping the adapter uses. Replace it with your system's: the project
 * API's in `project-mapping.ts` is a worked one
 * (docs/worked-example.md#mapping-a-real-system).
 */
export const recordMapping = sampleShapeMapping;
