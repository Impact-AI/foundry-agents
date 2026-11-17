import type { Instrument, Stage } from "./stage";
import { pageCount } from "./stage";

/**
 * What is on the stage, in the contract's line shape — `stage.<section>:
 * <one line>`, and `stage.empty` when nothing is up. The typed channel
 * registers one readable per line (label and value either side of the
 * colon, which is how the backend renders them); the live session is sent
 * the same lines, posted to it whenever the stage changes.
 */
export interface ContextLine {
	label: string;
	value: string;
}

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

function describe(instrument: Instrument): string {
	switch (instrument.section) {
		case "library": {
			const n = instrument.documents.length;
			const tags = instrument.tags.length
				? ` tagged ${instrument.tags.join(", ")}`
				: "";
			const titles = instrument.documents.map((d) => quote(d.title)).join(", ");
			return `${n} document${n === 1 ? "" : "s"} for ${quote(instrument.query)}${tags}: ${titles || "none"}`;
		}
		case "reader":
			return `${quote(instrument.document.title)}, page ${instrument.page} of ${pageCount(instrument.document)}`;
		case "media":
			return `image ${instrument.item.title ? quote(instrument.item.title) : "(untitled)"}`;
		case "chart":
			return `${quote(instrument.chart.title)} — ${instrument.chart.series.map((s) => s.name).join(", ")}${instrument.chart.unit ? ` in ${instrument.chart.unit}` : ""}`;
		case "record":
			return `${instrument.record.kind} ${quote(instrument.record.name)}`;
		case "records": {
			const n = instrument.records.length;
			const scope = [
				instrument.kind ? ` of kind ${instrument.kind}` : "",
				instrument.query ? ` for ${quote(instrument.query)}` : "",
			].join("");
			const names = instrument.records.map((r) => quote(r.name)).join(", ");
			return `${n} record${n === 1 ? "" : "s"}${scope}: ${names || "none"}`;
		}
	}
}

export function liveContextLines(stage: Stage): ContextLine[] {
	if (stage.length === 0)
		return [{ label: "stage.empty", value: "nothing is on the stage" }];
	return stage.map((i) => ({
		label: `stage.${i.section}`,
		value: describe(i),
	}));
}

export function renderContextLines(lines: readonly ContextLine[]): string {
	return lines.map((l) => `${l.label}: ${l.value}`).join("\n");
}
