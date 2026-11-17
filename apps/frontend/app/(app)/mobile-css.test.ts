import { describe, expect, test } from "bun:test";

/*
 * The phone's rules, held: every fixed layer over the scrolling page
 * contains its own swipe and the page is held while a sheet is up; no
 * `:hover` rule anywhere is unguarded on a screen that has no hover (on
 * touch a hover state is set by the tap and cleared by the next one); and
 * the root declarations a phone needs are there.
 */
const here = (p: string) => new URL(p, import.meta.url);
const globals = await Bun.file(here("../globals.css")).text();
const controls = await Bun.file(
	here("../components/controls/controls.css"),
).text();

/** Every stylesheet this app writes by hand — the ones a `:hover` can be in. */
const sheets: Record<string, string> = Object.fromEntries(
	await Promise.all(
		[
			"../globals.css",
			"../components/controls/controls.css",
			"../components/field/field.css",
			"../components/top-bar.css",
			"./chat/chat.css",
			"./chat/chat-cards.css",
			"./chat/thinking.css",
			"./guide/guide.css",
			"./stage/chart.css",
			"./stage/landing.css",
			"./stage/library.css",
			"./stage/media.css",
			"./stage/media-overlay.css",
			"./stage/reader.css",
			"./stage/record.css",
			"./stage/stage.css",
			"./stage/stage-pages.css",
			"./voice/voice.css",
			"./workspace/workspace.css",
		].map(async (p) => [p, await Bun.file(here(p)).text()] as const),
	),
);

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** The declaration blocks of every rule whose selector line is exactly `sel`. */
function blocks(css: string, sel: string): string[] {
	const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const out = [
		...stripComments(css).matchAll(
			new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm"),
		),
	].map((m) => m[1] ?? "");
	if (out.length === 0) throw new Error(`no rule for ${sel}`);
	return out;
}

function block(css: string, sel: string): string {
	return blocks(css, sel)[0] ?? "";
}

/** Every style rule whose selector list is all `:hover` and no `:focus-*`, with whether an `(hover: hover)` at-rule encloses it. */
function hoverOnlyRules(css: string): { sel: string; guarded: boolean }[] {
	const s = stripComments(css);
	const stack: string[] = [];
	const out: { sel: string; guarded: boolean }[] = [];
	let selStart = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "{") {
			stack.push(s.slice(selStart, i).trim());
			selStart = i + 1;
		} else if (ch === "}") {
			const sel = stack.pop() ?? "";
			if (!sel.startsWith("@")) {
				const parts = sel.split(",").map((p) => p.trim());
				const all = parts.every((p) => p.includes(":hover"));
				const twinned = parts.some((p) => /:focus-(visible|within)/.test(p));
				if (all && !twinned) {
					const guarded = stack.some((a) =>
						/@media[^{]*hover:\s*hover/.test(a),
					);
					out.push({ sel: sel.replace(/\s+/g, " "), guarded });
				}
			}
			selStart = i + 1;
		} else if (ch === ";") selStart = i + 1;
	}
	return out;
}

describe("the layers over a scrolling page", () => {
	test("every fixed layer contains its own swipe", () => {
		for (const [sel, css] of [
			[".dialog-backdrop", controls],
			[".menu-list", controls],
			[".media-overlay", sheets["./stage/media-overlay.css"] ?? ""],
			[".guide", sheets["./guide/guide.css"] ?? ""],
		] as const) {
			const placed = blocks(css, sel).filter((d) => d.includes("position:"));
			expect(placed.length, sel).toBeGreaterThan(0);
			for (const decl of placed)
				expect(decl, sel).toContain("overscroll-behavior: contain");
		}
	});

	test("the page is held while a sheet is up", () => {
		const lock = stripComments(globals).match(
			/^html:has\(([\s\S]*?)\)\s*\{([^}]*)\}/m,
		);
		if (!lock) throw new Error("globals.css has no html:has(…) lock");
		const [, list, decl] = lock;
		expect(decl).toContain("overflow: hidden");
		for (const sel of [".dialog-backdrop", ".media-overlay"])
			expect(list, sel).toContain(sel);
		// The guide is left out on purpose: its stops may stand below the fold.
		expect(list).not.toContain(".guide");
	});

	test("the tiles' scrollers and the thread contain the swipe too", () => {
		expect(
			block(
				sheets["./stage/stage.css"] ?? "",
				".stage-tile--record .stage-tile-body,\n.stage-tile--library .stage-tile-body",
			),
		).toContain("overscroll-behavior-y: contain");
		expect(
			block(sheets["./stage/reader.css"] ?? "", ".reader-scroll"),
		).toContain("overscroll-behavior-y: contain");
		expect(block(sheets["./chat/chat.css"] ?? "", ".chat-thread")).toContain(
			"overscroll-behavior-y: contain",
		);
	});
});

describe("no words on the bare field", () => {
	test("the stage's tiles, the conversation and the desk each stand on the panel ground", async () => {
		const ground = block(globals, ".panel,\n.card");
		for (const decl of [
			"border: 1px solid var(--line);",
			"background: var(--pane);",
			"box-shadow: var(--shadow-md);",
			"backdrop-filter: blur(14px);",
		])
			expect(ground).toContain(decl);
		for (const [file, cls] of [
			["./stage/StageTile.tsx", "panel stage-tile"],
			["./chat/ChatColumn.tsx", "panel chat-pane"],
			["./stage/GuidedLanding.tsx", "panel landing"],
		] as const)
			expect(await Bun.file(here(file)).text(), file).toContain(cls);
	});

	test("the reader's page scrolls above its pager and never runs under it", () => {
		const reader = sheets["./stage/reader.css"] ?? "";
		expect(block(reader, ".reader-scroll")).toContain("overflow-y: auto;");
		const foot = block(reader, ".reader-foot");
		expect(foot).toContain("flex: none;");
		expect(foot).not.toContain("position:");
	});
});

describe("hover on a screen that has none", () => {
	test("every hover-only rule is behind (hover: hover)", () => {
		const unguarded: string[] = [];
		for (const [file, css] of Object.entries(sheets)) {
			for (const r of hoverOnlyRules(css)) {
				if (!r.guarded) unguarded.push(`${file}: ${r.sel}`);
			}
		}
		expect(unguarded).toEqual([]);
	});

	test("a press still answers where hover cannot", () => {
		const m = controls.match(/@media \(hover: none\) \{([\s\S]*?)\n\}/);
		if (!m) throw new Error("no (hover: none) block");
		expect(m[1]).toContain(".icon-btn:active:not(:disabled)");
		expect(m[1]).toContain(".chip:active:not(:disabled)");
	});
});

describe("the root, on a phone", () => {
	test("type is not inflated in landscape, and a tap has no grey flash", () => {
		expect(block(globals, "html")).toContain("-webkit-text-size-adjust: 100%");
		expect(globals).toMatch(
			/button,\s*\[role="button"\],\s*canvas,\s*a \{\s*-webkit-tap-highlight-color: transparent;/,
		);
	});

	test("a fingertip gets 44px", () => {
		const coarse = globals.match(
			/@media \(pointer: coarse\) \{\s*:root \{\s*--thumb: (\d+)px;\s*--control-h: (\d+)px;/,
		);
		expect(coarse?.[1]).toBe("44");
		expect(coarse?.[2]).toBe("44");
		expect(controls).toMatch(
			/\.icon-btn \{[^}]*width: var\(--control-h\);[^}]*height: var\(--control-h\);/,
		);
		expect(controls).toMatch(
			/\.icon-btn::before \{\s*content: "";\s*position: absolute;\s*inset: -3px;/,
		);
		expect(controls).toMatch(/\.chip \{[^}]*min-block-size: var\(--thumb\);/);
		expect(sheets["./stage/stage.css"]).toMatch(/--stage-glyph: 44px;/);
	});

	test("the keyboard cap on the chat pane keeps its dvh fallback", () => {
		expect(globals).toMatch(
			/html\[data-vv-keyboard\] \.chat-pane \{[^}]*min-height: 0;\s*max-height: calc\(var\(--vvh, 100dvh\) - var\(--topbar-h\) - var\(--gutter\)\);/,
		);
	});
});

describe("motion is a preference", () => {
	test("every sheet that animates or transitions stands still under reduced motion", () => {
		for (const [file, css] of Object.entries(sheets)) {
			const moves = /\b(animation|transition):/.test(stripComments(css));
			if (!moves) continue;
			expect(css, file).toContain("@media (prefers-reduced-motion: reduce)");
		}
	});
});
