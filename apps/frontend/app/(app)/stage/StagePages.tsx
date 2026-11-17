"use client";

import { useTranslations } from "next-intl";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { Section, Stage } from "@/src/stage/stage";
import {
	activePage,
	type PageBox,
	pageLeft,
	tileOf,
} from "@/src/stage/stage-pages";
import { CARDS_GLYPH } from "../../components/controls";
import { prefersReducedMotion } from "../../components/motion";
import { useTileLabel } from "./tile-labels";
import "./stage-pages.css";

/**
 * The strip of what is open — the phone's miniatures of its pages. On a
 * phone the workspace is a pager: the conversation first, every tile a page
 * after it. The strip names each page, lights the one in view, and a press
 * brings that page across. Nothing until something is placed. Drawn only on
 * the stacked layout (`stage-pages.css`).
 */
const CHAT_PAGE = "chat";

const GLYPHS: Record<Section | "chat", ReactNode> = {
	chat: <path d="M4 5.5h16v10H9.5l-5.5 4z" />,
	library: (
		<>
			<rect x="3.5" y="4.5" width="5" height="15" rx="1" />
			<rect x="10" y="4.5" width="5" height="15" rx="1" />
			<path d="M16.2 5.6l4.2 1.1-3.6 13.1-4.2-1.1z" />
		</>
	),
	reader: (
		<>
			<path d="M5 4.5h10l4 4v11H5z" />
			<path d="M15 4.5v4h4M8 12h8M8 15.5h8" />
		</>
	),
	media: (
		<>
			<rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
			<circle cx="9" cy="10" r="1.6" />
			<path d="M20.5 15.5l-5-4-8 7" />
		</>
	),
	chart: (
		<>
			<path d="M4 17.5l5-6 4 4 7-9" />
			<path d="M3 20.5h18" />
		</>
	),
	record: (
		<>
			<circle cx="12" cy="9" r="3.5" />
			<path d="M5 20c1-4 4-6 7-6s6 2 7 6" />
		</>
	),
	records: CARDS_GLYPH,
};

function measure(pager: HTMLElement): PageBox[] {
	const pages: PageBox[] = [];
	for (const el of pager.querySelectorAll<HTMLElement>(
		".chat-pane, .stage-tile[data-key]:not(.is-leaving)",
	)) {
		const key = el.classList.contains("chat-pane")
			? CHAT_PAGE
			: (el.dataset.key ?? "");
		if (key) pages.push({ key, left: pageLeft(el, pager) });
	}
	return pages;
}

function pageOf(pager: HTMLElement, key: string): HTMLElement | null {
	return key === CHAT_PAGE
		? pager.querySelector<HTMLElement>(".chat-pane")
		: tileOf(pager, key);
}

export function StagePages({
	stage,
	pager,
}: {
	stage: Stage;
	pager: RefObject<HTMLElement | null>;
}) {
	const t = useTranslations("stage");
	const label = useTileLabel();
	const [active, setActive] = useState<string>(CHAT_PAGE);
	const up = stage.length > 0;
	const row = useRef<HTMLDivElement>(null);
	const wasKeys = useRef<string[]>([]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the stage changing is the event — the pages under the strip have changed
	useEffect(() => {
		if (!up) return;
		const el = pager.current;
		if (!el) return;
		let frame = 0;
		const read = () => {
			frame = 0;
			setActive(activePage(el.scrollLeft, measure(el)) ?? CHAT_PAGE);
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(read);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		const settle = window.setTimeout(read, 120);
		return () => {
			el.removeEventListener("scroll", onScroll);
			if (frame) cancelAnimationFrame(frame);
			window.clearTimeout(settle);
		};
	}, [up, pager, stage]);

	const goTo = useCallback(
		(key: string) => {
			const el = pager.current;
			if (!el) return;
			const page = pageOf(el, key);
			if (!page) return;
			el.scrollTo({
				left: pageLeft(page, el),
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});
		},
		[pager],
	);

	// The page in view closed: go to the one before it while it fades.
	useEffect(() => {
		const keys = stage.map((i) => i.section as string);
		const was = wasKeys.current;
		wasKeys.current = keys;
		if (active === CHAT_PAGE || keys.includes(active)) return;
		const at = was.indexOf(active);
		const before = at > 0 ? was[at - 1] : undefined;
		const next = before && keys.includes(before) ? before : CHAT_PAGE;
		setActive(next);
		goTo(next);
	}, [stage, active, goTo]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the active page changing is the event — the lit chip is found in the DOM
	useEffect(() => {
		row.current
			?.querySelector<HTMLElement>(".stage-page.is-active")
			?.scrollIntoView({ inline: "nearest", block: "nearest" });
	}, [active]);

	if (!up) return null;

	const page = (key: string, kind: Section | "chat", word: string) => {
		const on = active === key;
		return (
			<button
				key={key}
				type="button"
				className={`stage-page${on ? " is-active" : ""}`}
				aria-current={on ? "true" : undefined}
				onClick={() => goTo(key)}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
					<g
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						{GLYPHS[kind]}
					</g>
				</svg>
				<span className="stage-page-word">{word}</span>
			</button>
		);
	};

	return (
		<nav className="stage-pages" aria-label={t("pages")}>
			<div className="stage-pages-row" ref={row}>
				{page(CHAT_PAGE, "chat", t("pageChat"))}
				{stage.map((i) => page(i.section, i.section, label(i.section)))}
			</div>
		</nav>
	);
}
