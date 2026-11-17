/**
 * Every internal link of the built site leads somewhere: to a page the build
 * wrote, and, when it names a fragment, to an element of that page with that
 * id. VitePress fails its build on a dead page link but never reads a
 * fragment, and a heading's id on the site is not always its anchor on
 * GitHub, so this reads `dist/` after the build. The base it strips is the one
 * the build was given (`SITE_BASE`, as in the config).
 *
 *   bun run build && bun run check-anchors
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = join(import.meta.dir, "dist");
const BASE = process.env.SITE_BASE || "/foundry-agents/";

/** Every HTML file under `dir`, as its path from `dist/` without `.html`. */
function pages(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return pages(path);
		return entry.name.endsWith(".html")
			? [relative(DIST, path).replace(/\.html$/, "")]
			: [];
	});
}

const fromHtml = (value: string) =>
	value
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'");

/** Where a page is served, as the site's links are read against it. */
const served = (page: string) =>
	new URL(page.replace(/(^|\/)index$/, "$1"), `https://site${BASE}`);

/**
 * The page a link from `from` leads to, as `pages` names it, with the
 * fragment it names; `null` for a file that is no page.
 */
function targetOf(href: string, from: string) {
	const url = new URL(href, served(from));
	const fragment = decodeURIComponent(url.hash.slice(1));
	if (!url.pathname.startsWith(BASE))
		return { page: `(outside ${BASE}) ${url.pathname}`, fragment };
	const path = decodeURI(url.pathname.slice(BASE.length)).replace(
		/\.html$/,
		"",
	);
	if (path === "" || path.endsWith("/"))
		return { page: `${path}index`, fragment };
	return /\.[a-z0-9]+$/i.test(path) ? null : { page: path, fragment };
}

if (!existsSync(DIST)) {
	console.error(`no ${DIST}: build the site first (bun run build)`);
	process.exit(1);
}

const all = pages(DIST);
const ids = new Map(
	all.map((page) => {
		const html = readFileSync(join(DIST, `${page}.html`), "utf8");
		return [
			page,
			new Set(
				[...html.matchAll(/\sid="([^"]*)"/g)].map((m) => fromHtml(m[1] ?? "")),
			),
		];
	}),
);

const broken = new Set<string>();
for (const page of all) {
	const html = readFileSync(join(DIST, `${page}.html`), "utf8");
	for (const [, raw = ""] of html.matchAll(/<a\s[^>]*?href="([^"]*)"/g)) {
		const href = fromHtml(raw);
		if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
		const target = targetOf(href, page);
		if (target === null) continue;
		const targetIds = ids.get(target.page);
		if (!targetIds) broken.add(`${page}: ${href} names no page`);
		else if (target.fragment && !targetIds.has(target.fragment))
			broken.add(`${page}: ${href} names no element of ${target.page}`);
	}
}

if (broken.size > 0) {
	console.error([...broken].sort().join("\n"));
	console.error(`${broken.size} internal links lead nowhere`);
	process.exit(1);
}
console.log(`${all.length} pages: every internal link and its anchor resolve`);
