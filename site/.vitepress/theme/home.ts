/**
 * The landing page's additions: between the hero and the feature cards, the
 * workspace as people see it (`heroShot` in the front matter) and the row
 * of "Start here" cards (`cards.start`), one per reader, with the heading of
 * the feature row after it ("What comes assembled"); and in the page,
 * the video of a spoken turn.
 */
import { useData, withBase } from "vitepress";
import { defineComponent, h } from "vue";
import { DocCards } from "./doc-cards";

export const HeroShot = defineComponent({
	name: "HeroShot",
	setup() {
		const { frontmatter } = useData();
		return () => {
			const shot = frontmatter.value.heroShot as
				| { src: string; alt: string }
				| undefined;
			if (!shot) return null;
			return h(
				"div",
				{ class: "hero-shot" },
				h("img", {
					src: withBase(shot.src),
					alt: shot.alt,
					width: 1440,
					height: 900,
				}),
			);
		};
	},
});

interface Video {
	src: string;
	poster: string;
	captions: string;
	caption: string;
}

/**
 * The landing page's video (`video` in the front matter): captioned, with sound,
 * and fetched only when played. Its addresses are written here rather than
 * in the page's HTML, where the build would import each file and fail on
 * one that is not in `site/public/` yet; a missing file is a blank player.
 */
export const HomeVideo = defineComponent({
	name: "HomeVideo",
	setup() {
		const { frontmatter } = useData();
		return () => {
			const video = frontmatter.value.video as Video | undefined;
			if (!video) return null;
			return h("figure", { class: "home-video" }, [
				h(
					"video",
					{
						controls: true,
						muted: true,
						playsinline: true,
						preload: "metadata",
						poster: withBase(video.poster),
					},
					[
						h("source", { src: withBase(video.src), type: "video/mp4" }),
						h("track", {
							kind: "captions",
							src: withBase(video.captions),
							srclang: "en",
							label: "English",
							default: true,
						}),
					],
				),
				h("figcaption", video.caption),
			]);
		};
	},
});

export const StartHere = defineComponent({
	name: "StartHere",
	setup() {
		return () =>
			h("section", { class: "start-here vp-doc" }, [
				h("h2", { id: "start-here" }, "Start here"),
				h(DocCards, { group: "start" }),
				h("h2", { id: "what-comes-assembled" }, "What comes assembled"),
			]);
	},
});
