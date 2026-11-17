import { describe, expect, test } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import {
	conversationParam,
	privacyHref,
	settingsHref,
	workspaceHref,
} from "@/src/workspace-href";
import en from "../../messages/en.json";
import it from "../../messages/it.json";
import { BackToChat } from "./BackToChat";

const html = (conversation: string | null, messages = en, locale = "en") =>
	renderToStaticMarkup(
		<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
			<BackToChat conversation={conversation} />
		</NextIntlClientProvider>,
	);

describe("the way back to the chat", () => {
	test("goes to the conversation the room was opened from", () => {
		const out = html("c-42");
		expect(out).toContain('href="/chat?c=c-42"');
		expect(out).toContain(">Back to the chat</span>");
	});

	test("goes to the workspace, which opens the newest, when no conversation was carried", () => {
		expect(html(null)).toContain('href="/chat"');
	});

	test("is a link in the controls' style, its words its name on every screen", () => {
		const out = html("c-42");
		expect(out).toMatch(/^<a [^>]*class="btn btn--ghost btn--sm back-to-chat"/);
		expect(out).toContain('aria-hidden="true"');
		expect(out).toContain('class="back-to-chat-label"');
		expect(html(null, it, "it")).toContain(">Torna alla chat</span>");
	});

	test("carries only what is a conversation id", () => {
		expect(conversationParam("3f2a-b_9")).toBe("3f2a-b_9");
		expect(conversationParam("../settings")).toBeNull();
		expect(conversationParam("x".repeat(81))).toBeNull();
		expect(conversationParam(["a", "b"])).toBeNull();
		expect(conversationParam(undefined)).toBeNull();
	});

	test("every room keeps the conversation in its own link", () => {
		expect(workspaceHref("a b")).toBe("/chat?c=a%20b");
		expect(settingsHref("c-1")).toBe("/settings?c=c-1");
		expect(privacyHref(null)).toBe("/privacy");
	});
});
