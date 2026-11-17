"use client";

import { type ComponentProps, useMemo } from "react";
import { MarkdownImage } from "../MediaImage";
import {
	PlainText,
	type StreamdownModule,
	useStreamdown,
} from "./streamdown-lazy";
import "./markdown.css";

type StreamdownProps = ComponentProps<StreamdownModule["Streamdown"]>;
type Plugin = NonNullable<StreamdownProps["rehypePlugins"]>[number];
type Components = NonNullable<StreamdownProps["components"]>;

interface MdNode {
	type: string;
	value?: string;
	children?: MdNode[];
}

const BLOCK_PARENTS = new Set([
	"root",
	"blockquote",
	"listItem",
	"footnoteDefinition",
]);

/**
 * Raw HTML in the source becomes the characters that were written: a
 * paragraph where it stood as a block, text where it stood inside one. The
 * renderer's own `raw` step would parse it into elements, and a person's
 * text is never markup.
 */
function htmlAsText() {
	const walk = (parent: MdNode): void => {
		if (!parent.children) return;
		parent.children = parent.children.map((node) => {
			if (node.type !== "html") {
				walk(node);
				return node;
			}
			const text = { type: "text", value: node.value ?? "" };
			return BLOCK_PARENTS.has(parent.type)
				? { type: "paragraph", children: [text] }
				: text;
		});
	};
	return walk;
}

const LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** Headings moved down so the document's outline continues under the page's own. */
function headingsBelow(level: number): Components {
	const components: Components = {};
	LEVELS.forEach((tag, i) => {
		const Tag = LEVELS[Math.min(i + level, LEVELS.length - 1)] ?? "h6";
		components[tag] = ({ node: _, ...props }) => <Tag {...props} />;
	});
	return components;
}

function pick(plugins: Record<string, Plugin>, names: string[]): Plugin[] {
	return names
		.map((name) => plugins[name])
		.filter((plugin): plugin is Plugin => plugin !== undefined);
}

/**
 * Markdown the page did not write — a reasoning summary —
 * rendered: GitHub's flavour, links hardened, images only from this
 * origin, no HTML, no maths, nothing streamed. `under` is the level of the
 * heading the document sits beneath.
 */
export function Markdown({ source, under }: { source: string; under: number }) {
	const module = useStreamdown();
	const options = useMemo(
		() =>
			module && {
				remarkPlugins: [
					...pick(module.defaultRemarkPlugins, ["gfm"]),
					htmlAsText,
				],
				rehypePlugins: pick(module.defaultRehypePlugins, [
					"sanitize",
					"harden",
				]),
				components: { ...headingsBelow(under), img: MarkdownImage },
			},
		[module, under],
	);
	if (!module || !options)
		return <PlainText className="markdown">{source}</PlainText>;
	return (
		<module.Streamdown
			className="markdown"
			mode="static"
			parseIncompleteMarkdown={false}
			controls={false}
			{...options}
		>
			{source}
		</module.Streamdown>
	);
}
