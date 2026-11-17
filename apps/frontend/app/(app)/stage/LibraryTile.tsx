"use client";

import { useTranslations } from "next-intl";
import type { Instrument } from "@/src/stage/stage";
import { Tags } from "../../components/controls";
import { Carousel } from "./Carousel";
import { DocumentCard } from "./DocumentCard";
import { useStageActions } from "./stage-actions";
import "./library.css";

/**
 * The least a document card needs to read well: its title, three lines of
 * summary and its tags under a picture strip. A view holds as many as fit.
 */
const CARD_FLOOR = { width: 280, height: 260 } as const;

/** The library: the documents a search returned, as cards in a row. */
export function LibraryTile({
	instrument,
}: {
	instrument: Extract<Instrument, { section: "library" }>;
}) {
	const t = useTranslations("library");
	const actions = useStageActions();
	const { documents, query, tags } = instrument;
	return (
		<div className="library">
			<p className="library-query">
				<span>
					{query
						? t("found", { count: documents.length, query })
						: t("foundAll", { count: documents.length })}
				</span>
				<Tags tags={tags} />
			</p>
			{documents.length === 0 ? (
				<p className="library-empty">{t("empty")}</p>
			) : (
				<Carousel
					floor={CARD_FLOOR}
					label={t("carousel")}
					stepLabel={(d) => t(d)}
					position={({ first, last }, total) =>
						first === last
							? t("position", { n: first, total })
							: t("range", { first, last, total })
					}
				>
					{documents.map((document) => (
						<DocumentCard
							key={document.id}
							document={document}
							onOpen={actions.openDocument}
						/>
					))}
				</Carousel>
			)}
		</div>
	);
}
