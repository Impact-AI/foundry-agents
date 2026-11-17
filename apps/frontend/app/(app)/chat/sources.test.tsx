import { expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../../../messages/en.json";
import { SourceChipList } from "./Sources";

/**
 * The sources under a reply: one chip a document in the house chip style,
 * with its picture when it has one, and a press opening that document by
 * id — read off the tree the list draws, since the chip's handler is what
 * the stage's `openDocument` is handed.
 */
const html = (node: ReactNode) =>
	renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			{node}
		</NextIntlClientProvider>,
	);

const sources = [
	{
		id: "a".repeat(32),
		title: "Depot opening and closing checklist",
		thumbnailUrl: "/api/media/%40sample/pictures/depot-dawn.png",
	},
	{ id: "b".repeat(32), title: "No pictures" },
];

test("the sources draw as chips under the label, a picture inside the chip that has one, and none at all for a reply that drew on nothing", () => {
	const out = html(
		<SourceChipList
			label={en.chat.sources}
			sources={sources}
			onOpen={() => {}}
		/>,
	);
	expect(out).toContain(`>${en.chat.sources}</span>`);
	expect(out).toContain('class="assistant-sources-label"');
	expect(out.match(/class="chip source-chip"/g)).toHaveLength(2);
	expect(out).toContain("Depot opening and closing checklist");
	expect(out).toContain('src="/api/media/%40sample/pictures/depot-dawn.png"');
	expect(out.match(/source-chip-figure/g)).toHaveLength(1);
	expect(
		html(<SourceChipList label="Sources" sources={[]} onOpen={() => {}} />),
	).toBe("");
});

test("a press on a chip opens its document", () => {
	const opened: string[] = [];
	const tree = SourceChipList({
		label: "Sources",
		sources,
		onOpen: (id) => opened.push(id),
	}) as ReactElement<{ children: ReactNode }>;
	const chips = (
		Array.isArray(tree.props.children)
			? tree.props.children.flat()
			: [tree.props.children]
	).filter(
		(child): child is ReactElement<{ onClick: () => void }> =>
			!!child &&
			typeof child === "object" &&
			"props" in child &&
			typeof (child as ReactElement<{ onClick?: unknown }>).props.onClick ===
				"function",
	);
	expect(chips).toHaveLength(2);
	chips[1]?.props.onClick();
	chips[0]?.props.onClick();
	expect(opened).toEqual(["b".repeat(32), "a".repeat(32)]);
});
