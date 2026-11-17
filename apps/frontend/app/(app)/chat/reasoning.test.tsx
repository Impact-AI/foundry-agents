import { beforeAll, describe, expect, test } from "bun:test";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	advance,
	reasoningLabel,
	reasoningTurns,
	type ThreadMessage,
} from "@/src/chat/reasoning";
import en from "../../../messages/en.json";
import it from "../../../messages/it.json";
import { loadStreamdown } from "../../components/markdown/streamdown-lazy";
import {
	ReasoningMessage,
	ReasoningProvider,
	ReasoningView,
} from "./Reasoning";

/**
 * The reasoning disclosure: the turn it groups, the clock and the words it
 * reads, and the markup it draws closed, open and while the model thinks.
 * The renderer is loaded first, as the thread does before a summary opens.
 */
beforeAll(async () => {
	await loadStreamdown();
});

const html = (node: ReactNode) =>
	renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			{node}
		</NextIntlClientProvider>,
	);

const user = (id: string): ThreadMessage => ({
	id,
	role: "user",
	content: "Show me",
});
const thought = (id: string, content: string): ThreadMessage => ({
	id,
	role: "reasoning",
	content,
});
const said = (id: string): ThreadMessage => ({
	id,
	role: "assistant",
	content: "Here it is.",
});

const TURN = [
	user("u1"),
	thought("r1", "**Finding the documents**\n\nA search first."),
	said("a1"),
	thought("r2", ""),
	thought("r3", "**Wording the answer**\n\nLead with the handbook."),
	said("a2"),
];

describe("a turn's reasoning", () => {
	test("several parts in one turn are one disclosure, drawn at the latest part", () => {
		const turns = reasoningTurns(TURN, false);
		const turn = turns.get("r1");
		expect(turns.get("r2")).toBe(turn);
		expect(turns.get("r3")).toBe(turn);
		expect(turn?.key).toBe("r1");
		expect(turn?.drawnAt).toBe("r3");
		expect(turn?.summary).toBe(
			"**Finding the documents**\n\nA search first.\n\n**Wording the answer**\n\nLead with the handbook.",
		);
	});

	test("a message from the person starts the next turn's disclosure", () => {
		const turns = reasoningTurns(
			[...TURN, user("u2"), thought("r4", "Again.")],
			false,
		);
		expect(turns.get("r4")?.key).toBe("r4");
		expect(turns.get("r1")?.key).toBe("r1");
	});

	test("it is streaming only while the run is on and the thread ends in it", () => {
		const midway = TURN.slice(0, 5);
		expect(reasoningTurns(midway, true).get("r1")?.streaming).toBe(true);
		expect(reasoningTurns(midway, false).get("r1")?.streaming).toBe(false);
		expect(reasoningTurns(TURN, true).get("r1")?.streaming).toBe(false);
	});
});

describe("the time it took", () => {
	test("sums the spans it was seen streaming, and a second look changes nothing", () => {
		let clock = advance(undefined, true, 1_000);
		clock = advance(clock, true, 2_000);
		clock = advance(clock, false, 4_000);
		clock = advance(clock, false, 9_000);
		clock = advance(clock, true, 10_000);
		clock = advance(clock, false, 11_500);
		expect(clock).toEqual({ spentMs: 4_500, since: null });
	});

	test("reads as thinking, a few seconds, seconds, minutes — or no time it never saw", () => {
		const spent = (spentMs: number) => ({ spentMs, since: null });
		expect(reasoningLabel(true, spent(9_000))).toEqual({ key: "thinking" });
		expect(reasoningLabel(false, spent(1_400))).toEqual({ key: "briefly" });
		expect(reasoningLabel(false, spent(4_400))).toEqual({
			key: "seconds",
			count: 4,
		});
		expect(reasoningLabel(false, spent(150_000))).toEqual({
			key: "minutes",
			count: 3,
		});
		expect(reasoningLabel(false, undefined)).toEqual({ key: "unmeasured" });
	});

	test("the catalogues say it in the plural each language needs", () => {
		const say = (messages: typeof en, locale: string) =>
			createTranslator({ locale, messages, namespace: "reasoning" });
		const english = say(en, "en");
		expect(english("thinking")).toBe("Thinking…");
		expect(english("briefly")).toBe("Thought for a few seconds");
		expect(english("seconds", { count: 1 })).toBe("Thought for 1 second");
		expect(english("seconds", { count: 4 })).toBe("Thought for 4 seconds");
		expect(english("minutes", { count: 1 })).toBe("Thought for a minute");
		const italian = say(it, "it");
		expect(italian("seconds", { count: 1 })).toBe("Ho pensato per 1 secondo");
		expect(italian("seconds", { count: 4 })).toBe("Ho pensato per 4 secondi");
	});
});

const SUMMARY = "**Finding the documents**\n\nA search *first*.";

function view(open: boolean, onToggle = () => {}, streaming = false) {
	return (
		<ReasoningView
			id="reasoning-r1"
			label={streaming ? "Thinking…" : "Thought for 4 seconds"}
			summary={SUMMARY}
			streaming={streaming}
			open={open}
			onToggle={onToggle}
		/>
	);
}

/** The first element of `type` in a rendered tree, props and all. */
function find(node: unknown, type: string): ReactElement | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = find(child, type);
			if (hit) return hit;
		}
		return null;
	}
	const element = node as ReactElement<{ children?: unknown }>;
	if (element.type === type) return element;
	return find(element.props?.children, type);
}

describe("the disclosure", () => {
	test("is closed by default: a button that says so, and no summary in the page", () => {
		const out = html(view(false));
		expect(out).toContain('aria-expanded="false"');
		expect(out).toContain('aria-controls="reasoning-r1-summary"');
		expect(out).toMatch(/id="reasoning-r1-summary"[^>]*hidden/);
		expect(out).toContain("Thought for 4 seconds");
		expect(out).not.toContain("Finding the documents");
		expect(out).not.toContain("search");
	});

	test("open, the summary is rendered Markdown inside the region the button controls", () => {
		const out = html(view(true));
		expect(out).toContain('aria-expanded="true"');
		const region = out.slice(out.indexOf('id="reasoning-r1-summary"'));
		expect(out.indexOf("Finding the documents")).toBeGreaterThan(
			out.indexOf('id="reasoning-r1-summary"'),
		);
		expect(region).toContain('aria-labelledby="reasoning-r1-toggle"');
		expect(region).toMatch(/data-streamdown="strong"|<strong/);
		expect(region).toContain("<em>first</em>");
		expect(out).not.toContain("**");
		expect(out.match(/Finding the documents/g)?.length).toBe(1);
	});

	test("its button opens and closes it, and aria-expanded follows", () => {
		let open = false;
		const press = () => {
			const button = find(
				ReasoningView(view(open, () => (open = !open)).props),
				"button",
			);
			if (!button) throw new Error("no button");
			(button.props as { onClick: () => void }).onClick();
		};
		press();
		expect(open).toBe(true);
		expect(html(view(open))).toContain('aria-expanded="true"');
		press();
		expect(open).toBe(false);
		expect(html(view(open))).toContain('aria-expanded="false"');
	});

	test("a native button, so the keyboard opens it as it presses any other", () => {
		const button = find(ReasoningView(view(false).props), "button");
		expect(button?.props).toMatchObject({ type: "button" });
	});

	test("reads Thinking… while the model reasons, marked for the wait's motion", () => {
		const out = html(view(false, () => {}, true));
		expect(out).toContain("Thinking…");
		expect(out).toMatch(/class="reasoning" data-streaming=""/);
	});

	test("a turn whose reasoning carried no words is the line alone, with nothing to open", () => {
		const out = html(
			<ReasoningView
				id="reasoning-r9"
				label="Thought for a few seconds"
				summary=""
				streaming={false}
				open={false}
				onToggle={() => {}}
			/>,
		);
		expect(out).not.toContain("<button");
		expect(out).toContain("Thought for a few seconds");
	});
});

describe("in the thread", () => {
	const drawn = (messages: ThreadMessage[], isRunning: boolean) =>
		html(
			<ReasoningProvider messages={messages} isRunning={isRunning}>
				{messages
					.filter((m) => m.role === "reasoning")
					.map((m) => (
						<ReasoningMessage
							key={m.id}
							message={m as Parameters<typeof ReasoningMessage>[0]["message"]}
						/>
					))}
			</ReasoningProvider>,
		);

	test("three parts in one turn draw one disclosure, closed", () => {
		const out = drawn(TURN, false);
		expect(out.match(/class="reasoning"/g)?.length).toBe(1);
		expect(out.match(/aria-expanded="false"/g)?.length).toBe(1);
		expect(out).not.toContain("Wording the answer");
	});

	test("while the turn is still reasoning it says so", () => {
		expect(drawn(TURN.slice(0, 5), true)).toContain("Thinking…");
	});
});
