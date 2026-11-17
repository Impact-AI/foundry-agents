/**
 * Links and diagrams as the site renders a page.
 *
 * A page in `docs/` links to the code beside it (`../apps/backend/src/product.ts`)
 * as GitHub resolves it in place. On the site that path names nothing, so a
 * relative link whose target is not a page the site renders becomes the same
 * file on GitHub: a file's blob, a directory's tree. A link to another page
 * is left to the site, which checks it. A fenced `mermaid` block becomes the
 * `Mermaid` component, which draws it in the browser.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { MarkdownRenderer } from "vitepress";

interface Repository {
	/** The repository's address on GitHub, with no trailing slash. */
	repository: string;
	branch: string;
	/** The repository's root on disk. */
	root: string;
}

/** A target with a scheme, a page-local anchor or a site-absolute path is the site's own. */
const notRelative = (href: string) =>
	/^[a-z][a-z0-9+.-]*:/i.test(href) ||
	href.startsWith("#") ||
	href.startsWith("/");

/** Whether a repository path is one of the pages the site renders beside each other. */
const isPage = (path: string) => /^docs\/[^/]+\.md$/.test(path);

/**
 * Where a relative link leads on the site: the landing page at the site's
 * root, the code on GitHub, or nothing when it is another page, which the
 * site resolves itself.
 */
export function siteTarget(
	href: string,
	page: string,
	{ repository, branch, root }: Repository,
): string | null {
	if (notRelative(href)) return null;
	const [path = "", hash] = href.split("#", 2);
	if (!path) return null;
	const absolute = resolve(dirname(page), decodeURI(path));
	const inRepository = relative(root, absolute).split("\\").join("/");
	if (inRepository.startsWith("..")) return null;
	if (isPage(inRepository)) return null;
	if (inRepository === "site/index.md") return "/";
	const kind =
		existsSync(absolute) && statSync(absolute).isDirectory() ? "tree" : "blob";
	return `${repository}/${kind}/${branch}/${inRepository}${hash ? `#${hash}` : ""}`;
}

export function repositoryLinks(
	md: MarkdownRenderer,
	repository: Repository,
): void {
	const link = md.renderer.rules.link_open;
	md.renderer.rules.link_open = (tokens, index, options, env, self) => {
		const token = tokens[index];
		const href = token?.attrGet("href");
		// `realPath` is the file read; `path` is where a rewrite serves it.
		const page: unknown = env?.realPath ?? env?.path;
		if (token && href && typeof page === "string") {
			const target = siteTarget(href, page, repository);
			if (target === "/") token.attrSet("href", target);
			else if (target) {
				token.attrSet("href", target);
				token.attrSet("target", "_blank");
				token.attrSet("rel", "noreferrer");
			}
		}
		return link
			? link(tokens, index, options, env, self)
			: self.renderToken(tokens, index, options);
	};

	// The site compiles each page as a Vue template, where `{{` opens an
	// expression; the pages write it as text (a template variable's name), so
	// in prose and inline code it is written as the characters' references.
	for (const rule of ["text", "code_inline"] as const) {
		const render = md.renderer.rules[rule];
		md.renderer.rules[rule] = (tokens, index, options, env, self) =>
			(render
				? render(tokens, index, options, env, self)
				: self.renderToken(tokens, index, options)
			).replaceAll("{{", "&#123;&#123;");
	}

	const fence = md.renderer.rules.fence;
	md.renderer.rules.fence = (tokens, index, options, env, self) => {
		const token = tokens[index];
		if (token && token.info.trim() === "mermaid")
			return `<Mermaid code="${encodeURIComponent(token.content)}" />`;
		return fence ? fence(tokens, index, options, env, self) : "";
	};
}
