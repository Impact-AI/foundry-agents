import { describe, expect, test } from "bun:test";
import { CopilotKit } from "@copilotkit/react-core/v2";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "../../../messages/en.json";
import { VoiceProvider } from "../workspace/voice-context";
import { Composer } from "./Composer";

/**
 * Send, as the composer draws it. The runtime refuses a message while a
 * picture waiting to go is still being prepared, after the composer has
 * already cleared the words — so Send waits for the picture instead.
 */
const nothing = () => {};

/** The voice channel as the composer sees it: there, and open or not. */
const channel = (open: boolean) => ({
	open,
	setOpen: nothing,
	held: false,
	hold: nothing,
	outbox: { post: nothing, take: nothing },
	capability: { live: true },
	locale: "en",
	threadId: "t1",
	handlers: {} as never,
	briefs: [],
	stage: [],
});

function composer(
	value: string,
	uploading: boolean,
	isRunning = false,
	voice: boolean | null = null,
) {
	const field = (
		<Composer
			value={value}
			onChange={nothing}
			onSubmit={nothing}
			onStop={nothing}
			isRunning={isRunning}
			uploading={uploading}
		/>
	);
	return renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			<CopilotKit
				runtimeUrl="/api/copilotkit"
				showDevConsole={false}
				enableInspector={false}
			>
				{voice === null ? (
					field
				) : (
					<VoiceProvider value={channel(voice)}>{field}</VoiceProvider>
				)}
			</CopilotKit>
		</NextIntlClientProvider>,
	);
}

const button = (out: string, label: string) =>
	out.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
const sendButton = (out: string) => button(out, messages.chat.send);

describe("the composer's send", () => {
	test("is on once there are words and every picture is ready", () => {
		expect(sendButton(composer("hello", false))).not.toContain("disabled");
	});

	test("waits while a picture is still being prepared", () => {
		expect(sendButton(composer("hello", true))).toContain('disabled=""');
	});

	test("queues, not stops, while a run is in flight and words wait", () => {
		const out = composer("hello", false, true);
		expect(button(out, messages.chat.queue)).not.toBe("");
		expect(button(out, messages.chat.queue)).not.toContain("disabled");
		expect(out).not.toContain(`aria-label="${messages.chat.stop}"`);
	});

	test("the queue waits too while a picture is still being prepared", () => {
		const out = composer("hello", true, true);
		expect(button(out, messages.chat.queue)).toContain('disabled=""');
	});

	test("is a stop while a run is in flight and nothing is typed", () => {
		const out = composer("", false, true);
		expect(button(out, messages.chat.stop)).not.toBe("");
	});
});

describe("the composer under the voice pane", () => {
	test("offers the channel while it is closed, and sends to it, not a stop, while it is open", () => {
		const closed = composer("hello", false, false, false);
		expect(button(closed, messages.voice.start)).not.toBe("");
		expect(closed).toContain(`placeholder="${messages.chat.placeholder}"`);
		const open = composer("hello", false, false, true);
		expect(button(open, messages.voice.start)).toBe("");
		expect(open).toContain(`placeholder="${messages.chat.placeholderVoice}"`);
		expect(sendButton(open)).not.toContain("disabled");
	});
});
