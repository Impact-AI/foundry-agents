/**
 * Who makes the template and what it runs on, above the landing page's
 * title: each maker's logo when its file is in `site/public/logos/`, and its
 * name as text when it is not, so no mark is drawn that its owner did not
 * supply.
 */
import { useData, withBase } from "vitepress";
import { defineComponent, h } from "vue";

interface Maker {
	name: string;
	src: string | null;
	/** The logo the dark theme shows, when the maker supplied one. */
	srcDark: string | null;
}

const img = (src: string, alt: string, only?: "light" | "dark") =>
	h("img", {
		class: only ? `maker-logo ${only}-only` : "maker-logo",
		src: withBase(`/${src}`),
		alt,
	});

export const Makers = defineComponent({
	name: "Makers",
	setup() {
		const { theme } = useData<{ logos?: Maker[] }>();
		return () =>
			h(
				"div",
				{ class: "makers" },
				(theme.value.logos ?? []).flatMap((maker) => {
					if (!maker.src)
						return [h("span", { class: "maker-name" }, maker.name)];
					if (!maker.srcDark) return [img(maker.src, maker.name)];
					return [
						img(maker.src, maker.name, "light"),
						img(maker.srcDark, maker.name, "dark"),
					];
				}),
			);
	},
});
