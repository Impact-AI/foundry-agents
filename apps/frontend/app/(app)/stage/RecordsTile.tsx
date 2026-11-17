"use client";

import { useTranslations } from "next-intl";
import { type Instrument, RECORD_KINDS } from "@/src/stage/stage";
import { Chip } from "../../components/controls";
import { useStageActions } from "./stage-actions";
import "./record.css";

/** The records on file, grouped by kind: one chip each, a press away from its card. */
export function RecordsTile({
	instrument,
}: {
	instrument: Extract<Instrument, { section: "records" }>;
}) {
	const t = useTranslations("records");
	const kinds = useTranslations("record.kinds");
	const actions = useStageActions();
	const { records, query } = instrument;
	const groups = RECORD_KINDS.map(
		(kind) => [kind, records.filter((r) => r.kind === kind)] as const,
	).filter(([, of]) => of.length > 0);
	return (
		<div className="records">
			<p className="records-query">
				{query
					? t("found", { count: records.length, query })
					: t("foundAll", { count: records.length })}
			</p>
			{groups.length === 0 ? (
				<p className="records-empty">{t("empty")}</p>
			) : (
				groups.map(([kind, of]) => (
					<div key={kind} className="records-group">
						<p className="eyebrow">{kinds(kind)}</p>
						<ul className="record-links-list">
							{of.map((record) => (
								<li key={record.id}>
									<Chip
										title={record.summary}
										onClick={() => actions.showRecord(record.kind, record.id)}
									>
										{record.name}
									</Chip>
								</li>
							))}
						</ul>
					</div>
				))
			)}
		</div>
	);
}
