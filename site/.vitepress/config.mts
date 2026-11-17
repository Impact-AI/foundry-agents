/**
 * The documentation site: the landing page in `site/index.md` and the pages
 * of `docs/`, rendered where they are. The source directory is the
 * repository's root, so a page is read from the one file GitHub shows too;
 * everything at the root but `docs/` and this page is left out, and the
 * rewrites serve `docs/<page>.md` at `/<page>`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { slug } from "github-slugger";
import { type DefaultTheme, defineConfigWithTheme } from "vitepress";
import { repositoryLinks } from "./repository-links";

const REPOSITORY = "https://github.com/Impact-AI/foundry-agents";
// The branch source and edit links point at: the released site's is main; a
// preview built from another branch names it so its links show the same code.
const BRANCH = process.env.SITE_BRANCH || "main";
// From `import.meta.url`, which the config's bundler keeps as this file's own
// address; `import.meta.dirname` would name the bundle's.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SITE = join(ROOT, "site");

/** Every entry at the root but the two the site renders, as globs to leave out. */
const outside = readdirSync(ROOT)
	.filter((name) => name !== "docs" && name !== "site")
	.map((name) =>
		statSync(join(ROOT, name)).isDirectory() ? `${name}/**` : name,
	);

/** The path of a logo when its file is there, else null. */
const logoFile = (file: string) =>
	existsSync(join(ROOT, "site", "public", "logos", file))
		? `logos/${file}`
		: null;

/**
 * A logo is shown only when its file is there; otherwise its name, as text.
 * A `<name>-dark.svg` beside it is the one the dark theme shows.
 */
const logo = (file: string, name: string) => ({
	name,
	src: logoFile(file),
	srcDark: logoFile(file.replace(/\.svg$/, "-dark.svg")),
});

/** The pages, in the groups the top bar and the sidebar both show. */
const overview = [
	{ text: "What it is", link: "/#what-it-is" },
	{ text: "Is it a fit?", link: "/is-it-a-fit" },
	{ text: "Cost", link: "/cost" },
];
const build = [
	{ text: "Patterns", link: "/patterns" },
	{ text: "Adapting", link: "/adapting" },
	{ text: "Worked example", link: "/worked-example" },
	{ text: "Extending", link: "/extending" },
	{ text: "Documents", link: "/documents" },
	{ text: "Development", link: "/development" },
	{ text: "Testing", link: "/testing" },
];
const run = [
	{ text: "Deployment", link: "/deployment" },
	{ text: "Operations", link: "/operations" },
	{ text: "Security", link: "/security" },
	{ text: "Privacy", link: "/privacy" },
];
const accept = [
	{ text: "Acceptance", link: "/acceptance" },
	{ text: "Evaluation", link: "/evaluation" },
];
const reference = [
	{ text: "Architecture", link: "/architecture" },
	{ text: "Configuration", link: "/configuration" },
	{ text: "Decisions", link: "/decisions" },
	{ text: "Repository", link: "/repository" },
	{ text: "Limitations", link: "/limitations" },
];
const addOns = [{ text: "Impact AI add-ons", link: "/impact-ai" }];

/** The default theme's settings, and the makers the landing page names. */
type ThemeConfig = DefaultTheme.Config & {
	logos: { name: string; src: string | null; srcDark: string | null }[];
};

export default defineConfigWithTheme<ThemeConfig>({
	title: "Agent on Azure",
	description:
		"Kickstart a voice-enabled AI application on Azure: chat, voice, document retrieval and a visual workspace to adapt and deploy in your own Azure environment.",
	lang: "en",
	// Where Pages serves the site: under the repository's name on a public
	// repository, at the root of its own address on a private one. The
	// workflow passes what Pages says; a local build assumes the public path.
	base: process.env.SITE_BASE || "/foundry-agents/",
	srcDir: "..",
	srcExclude: [...outside, "site/README.md", "**/node_modules/**"],
	rewrites: {
		"site/index.md": "index.md",
		"docs/:page.md": ":page.md",
	},
	// A page may point at the app running on the reader's own machine; every
	// other link is checked, and a dead one fails the build.
	ignoreDeadLinks: "localhostLinks",
	outDir: "dist",
	cacheDir: "node_modules/.vitepress-cache",
	cleanUrls: true,
	lastUpdated: false,
	head: [["meta", { name: "theme-color", content: "#0f6cbd" }]],
	// The pages compile to modules beside them, in `docs/`, from where `vue`
	// would be looked for in the root's packages, which do not have it: it is
	// resolved from this package's instead.
	vite: {
		// The source is the repository's root, whose own `public/` this is not.
		publicDir: join(ROOT, "site", "public"),
		ssr: { external: ["vue", "vue/server-renderer"] },
		plugins: [
			{
				name: "pages-resolve-from-site",
				enforce: "pre",
				resolveId(id, importer, options) {
					if (!importer || importer.startsWith(SITE)) return null;
					return this.resolve(id, join(SITE, "index.md"), {
						...options,
						skipSelf: true,
					});
				},
			},
		],
	},
	markdown: {
		// A heading's id is GitHub's slug for it, so an anchor a page links to
		// is the same on the site as on GitHub. VitePress's own drops an
		// apostrophe as a dash and puts `_` before a leading digit; repeats are
		// numbered `-1`, `-2` by both.
		anchor: { slugify: (text: string) => slug(text) },
		config: (md) =>
			repositoryLinks(md, {
				repository: REPOSITORY,
				branch: BRANCH,
				root: ROOT,
			}),
	},
	themeConfig: {
		siteTitle: "Agent on Azure",
		logos: [
			logo("microsoft.svg", "Microsoft"),
			logo("impact-ai.svg", "Impact AI"),
		],
		// The top bar by audience, the sidebar by task. A page's label is its
		// title, the same in both places and as its `#` heading.
		nav: [
			{ text: "Overview", items: overview },
			{ text: "Build", items: build },
			{ text: "Deploy and run", items: run },
			{ text: "Accept", items: accept },
			{ text: "Reference", items: reference },
			{ text: "Impact AI add-ons", link: "/impact-ai" },
		],
		sidebar: [
			{ text: "Decide whether it fits", items: overview },
			{ text: "Build your application", items: build },
			{ text: "Deploy and run it", items: run },
			{ text: "Accept it", items: accept },
			{ text: "Look something up", items: reference },
			{ text: "Impact AI add-ons", items: addOns },
		],
		socialLinks: [{ icon: "github", link: REPOSITORY }],
		search: { provider: "local" },
		editLink: {
			pattern: `${REPOSITORY}/edit/${BRANCH}/:path`,
			text: "Edit this page on GitHub",
		},
		outline: { level: [2, 3] },
		footer: {
			message:
				"MIT licensed, except the Impact SDK setup plugin (Apache-2.0). Copyright Microsoft Corporation. Created and maintained by Impact AI.",
		},
	},
});
