"use client";

import { useTranslations } from "next-intl";
import { measureNames } from "@/src/stage/measure-names";
import type { RecordView } from "@/src/stage/stage";
import { uniqueKeys } from "@/src/unique-keys";
import { Chip } from "../../components/controls";
import { useStageActions } from "./stage-actions";
import "./record.css";

/** An entity at a glance: its kind, its name, its fields, the records it links to and the figures it keeps — each a press away. */
export function RecordCard({ record }: { record: RecordView }) {
	const t = useTranslations("record");
	const actions = useStageActions();
	const measures = record.measures ?? [];
	const names = measureNames(t);
	const fieldKeys = uniqueKeys(record.fields.map((field) => field.label));
	return (
		<section className="record-card">
			<p className="eyebrow eyebrow--accent">{t(`kinds.${record.kind}`)}</p>
			<h2 className="record-name">{record.name}</h2>
			{record.fields.length ? (
				<dl className="record-fields">
					{record.fields.map((field, n) => (
						<div key={fieldKeys[n]} className="record-field">
							<dt>{field.label}</dt>
							<dd>{field.value}</dd>
						</div>
					))}
				</dl>
			) : null}
			{record.links.length ? (
				<div className="record-links">
					<p className="eyebrow">{t("links")}</p>
					<ul className="record-links-list">
						{record.links.map((link) => (
							<li key={`${link.kind}:${link.id}`}>
								<Chip onClick={() => actions.showRecord(link.kind, link.id)}>
									<span className="chip-kind">{t(`kinds.${link.kind}`)}</span>
									<span>{link.name}</span>
								</Chip>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{measures.length ? (
				<div className="record-links">
					<p className="eyebrow">{t("measures")}</p>
					<ul className="record-links-list">
						{measures.map((measure) => (
							<li key={measure.key}>
								<Chip
									className="record-measure"
									onClick={() =>
										actions.showMeasure(record.kind, record.id, measure.key)
									}
								>
									<span>{names.label(measure.key)}</span>
									<span className="chip-kind">{names.unit(measure.unit)}</span>
								</Chip>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}
