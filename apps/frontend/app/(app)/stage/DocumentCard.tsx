"use client";

import { useTranslations } from "next-intl";
import type { LibraryDocument } from "@/src/stage/stage";
import { IconImage, Tags } from "../../components/controls";
import { MediaImage } from "../../components/MediaImage";

/** One document in the library: its picture, its title, its summary, its tags; a press opens it in the reader. */
export function DocumentCard({
	document,
	onOpen,
}: {
	document: LibraryDocument;
	onOpen: (id: string) => void;
}) {
	const t = useTranslations("library");
	// The name holds everything the card shows, after the verb: a name of the
	// title alone would hide the summary and the tags from a screen reader,
	// and fail WCAG 2.5.3 (Label in Name) for the text it leaves out.
	const name = [
		t("open", { title: document.title }),
		document.summary,
		document.tags.join(", "),
	]
		.filter(Boolean)
		.join(". ");
	return (
		<button
			type="button"
			className="document-card"
			onClick={() => onOpen(document.id)}
			aria-label={name}
		>
			<span className="document-card-figure">
				{document.thumbnailUrl ? (
					<MediaImage src={document.thumbnailUrl} alt="" />
				) : (
					<span className="document-card-glyph" aria-hidden="true">
						<IconImage />
					</span>
				)}
			</span>
			{/* The spaces between the parts are not drawn (the body is a flex
			    column) but keep the card's text its words apart. */}
			<span className="document-card-body">
				<span className="document-card-title">{document.title}</span>{" "}
				{document.summary ? (
					<span className="document-card-summary">{document.summary}</span>
				) : null}{" "}
				<Tags tags={document.tags} />
			</span>
		</button>
	);
}
