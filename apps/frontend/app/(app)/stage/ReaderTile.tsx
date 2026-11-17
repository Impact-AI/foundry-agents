"use client";

import { useTranslations } from "next-intl";
import type { Instrument } from "@/src/stage/stage";
import { pageCount } from "@/src/stage/stage";
import { uniqueKeys } from "@/src/unique-keys";
import {
	IconButton,
	IconChevronLeft,
	IconChevronRight,
	Tags,
} from "../../components/controls";
import { MediaImage } from "../../components/MediaImage";
import { Markdown } from "../../components/markdown/Markdown";
import { useStageActions } from "./stage-actions";
import "./reader.css";

/**
 * The reader: a document open at a page. A page is one of the asset's
 * sections; the two arrows turn it, and each turn is seen (`page-in`). A
 * Markdown document's page is rendered, any other is shown as written. The
 * document's media stands under the page as a strip, each a press away
 * from the overlay. Everything above the pager scrolls, and ends where the
 * pager begins: no line is ever under it.
 */
export function ReaderTile({
	instrument,
}: {
	instrument: Extract<Instrument, { section: "reader" }>;
}) {
	const t = useTranslations("reader");
	const actions = useStageActions();
	const { document, page } = instrument;
	const total = pageCount(document);
	const section = document.sections[page - 1] ?? null;
	const mediaKeys = uniqueKeys(document.media.map((item) => item.url));

	return (
		<article className="reader">
			<div className="reader-scroll">
				<header className="reader-head">
					<h2 className="reader-title">{document.title}</h2>
					{document.summary ? (
						<p className="reader-summary">{document.summary}</p>
					) : null}
					<Tags tags={document.tags} />
				</header>

				<div className="reader-page" key={page}>
					{section ? (
						<>
							<h3 className="reader-heading">{section.heading}</h3>
							{document.markdown ? (
								<Markdown source={section.text} under={3} />
							) : (
								<div className="reader-text">{section.text}</div>
							)}
						</>
					) : (
						<p className="reader-text">{t("noPages")}</p>
					)}
				</div>

				{document.media.length ? (
					<ul className="reader-media" aria-label={t("media")}>
						{document.media.map((item, n) => (
							<li key={mediaKeys[n]}>
								<button
									type="button"
									className="reader-media-item"
									onClick={() => actions.enlarge(item)}
									aria-label={
										item.title
											? t("enlarge", { title: item.title })
											: t("enlargePicture")
									}
								>
									<MediaImage src={item.url} alt="" />
								</button>
							</li>
						))}
					</ul>
				) : null}
			</div>

			<footer className="reader-foot">
				<IconButton
					label={t("previous")}
					size="sm"
					onClick={() => actions.turnPage(page - 1)}
					disabled={page <= 1}
				>
					<IconChevronLeft />
				</IconButton>
				<span className="reader-position" aria-live="polite">
					{t("position", { n: page, total })}
				</span>
				<IconButton
					label={t("next")}
					size="sm"
					onClick={() => actions.turnPage(page + 1)}
					disabled={page >= total}
				>
					<IconChevronRight />
				</IconButton>
			</footer>
		</article>
	);
}
