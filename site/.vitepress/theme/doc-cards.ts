/**
 * A grid of links into the documentation, from the page's front matter
 * (`cards`, under the name the `group` prop gives), so the landing page lists
 * pages the way the theme's own feature cards do. A card with one `link` is
 * a link as a whole; a card with `links` names each page it leads to.
 */
import { useData, withBase } from "vitepress";
import { defineComponent, h } from "vue";

interface Link {
	text: string;
	link: string;
}

interface Card {
	title: string;
	details: string;
	link?: string;
	links?: Link[];
}

export const DocCards = defineComponent({
	name: "DocCards",
	props: { group: { type: String, required: true } },
	setup(props) {
		const { frontmatter } = useData();
		return () => {
			const cards: Card[] = frontmatter.value.cards?.[props.group] ?? [];
			return h(
				"div",
				{ class: "doc-cards" },
				cards.map((card) => {
					const body = [
						h("span", { class: "doc-card-title" }, card.title),
						h("span", { class: "doc-card-details" }, card.details),
					];
					if (card.link)
						return h(
							"a",
							{ class: "doc-card", href: withBase(card.link) },
							body,
						);
					return h("div", { class: "doc-card" }, [
						...body,
						h(
							"span",
							{ class: "doc-card-links" },
							(card.links ?? []).map((link) =>
								h("a", { href: withBase(link.link) }, link.text),
							),
						),
					]);
				}),
			);
		};
	},
});
