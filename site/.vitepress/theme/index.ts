/**
 * The default theme, with its additions: the `Mermaid` component the fenced
 * diagrams become, the row of makers above the landing page's title, the
 * workspace screenshot and the "Start here" row under the hero, tables that
 * stack on a phone (`tables.ts`), and the site's colors (`custom.css`).
 */
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { defineComponent, h } from "vue";
import "./custom.css";
import { DocCards } from "./doc-cards";
import { HeroShot, HomeVideo, StartHere } from "./home";
import { Makers } from "./makers";
import { Mermaid } from "./mermaid";
import { useTableLabels } from "./tables";

const Layout = defineComponent({
	name: "SiteLayout",
	setup() {
		useTableLabels();
		return () =>
			h(DefaultTheme.Layout, null, {
				"home-hero-info-before": () => h(Makers),
				"home-hero-after": () => h(HeroShot),
				"home-features-before": () => h(StartHere),
			});
	},
});

export default {
	extends: DefaultTheme,
	Layout,
	enhanceApp({ app }) {
		app.component("Mermaid", Mermaid);
		app.component("DocCards", DocCards);
		app.component("HomeVideo", HomeVideo);
	},
} satisfies Theme;
