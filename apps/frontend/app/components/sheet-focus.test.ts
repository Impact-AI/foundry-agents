import { describe, expect, test } from "bun:test";
import { previewRef } from "../(app)/chat/CameraCapture";
import { holdBeside } from "./controls/Dialog";
import { returnFocus } from "./use-return-focus";

/**
 * Where focus goes around a sheet, and what the sheet holds while it is up,
 * against stand-ins for the elements: the decisions are plain, the DOM only
 * carries them out.
 */
function element(name: string, connected = true) {
	const el = {
		name,
		isConnected: connected,
		focused: 0,
		focus() {
			el.focused += 1;
		},
	};
	return el;
}

describe("focus handed back when a sheet closes", () => {
	const body = { name: "body" };

	test("goes back to the opener when the sheet took it", () => {
		const opener = element("delete account");
		returnFocus(opener, null, { activeElement: body, body });
		expect(opener.focused).toBe(1);
	});

	test("goes to the fallback when the opener went with what opened the sheet", () => {
		const row = element("trash in a closed panel", false);
		const trigger = element("picker trigger");
		returnFocus(row, trigger, { activeElement: body, body });
		expect(row.focused).toBe(0);
		expect(trigger.focused).toBe(1);
	});

	test("is not taken back from where the person already put it", () => {
		const opener = element("opener");
		const composer = element("composer");
		returnFocus(opener, null, { activeElement: composer, body });
		expect(opener.focused).toBe(0);
	});

	test("goes nowhere when neither the opener nor the fallback is on the page", () => {
		const gone = element("gone", false);
		const alsoGone = element("also gone", false);
		returnFocus(gone, alsoGone, { activeElement: null, body });
		expect(gone.focused + alsoGone.focused).toBe(0);
	});
});

describe("a sheet holds the page beside it", () => {
	const node = (inert = false) => ({ inert }) as Element & { inert: boolean };

	test("everything beside the sheet is inert until it closes", () => {
		const sheet = node();
		const page = node();
		const announcer = node();
		const release = holdBeside(sheet, [page, sheet, announcer]);
		expect([page.inert, sheet.inert, announcer.inert]).toEqual([
			true,
			false,
			true,
		]);
		release();
		expect([page.inert, announcer.inert]).toEqual([false, false]);
	});

	test("what was inert for its own reasons stays inert", () => {
		const sheet = node();
		const already = node(true);
		holdBeside(sheet, [already, sheet])();
		expect(already.inert).toBe(true);
	});
});

describe("the camera's preview", () => {
	test("a preview mounted after the stream opened — a retake's — is handed the stream", () => {
		const stream = { current: { id: "camera" } as unknown as MediaStream };
		const video = { current: null as HTMLVideoElement | null };
		const attach = previewRef(video, stream);
		const retake = { srcObject: null } as unknown as HTMLVideoElement;
		attach(retake);
		expect(retake.srcObject).toBe(stream.current);
		expect(video.current).toBe(retake);
		attach(null);
		expect(video.current).toBeNull();
	});

	test("a preview mounted before the stream opens waits for it", () => {
		const stream = { current: null as MediaStream | null };
		const video = { current: null as HTMLVideoElement | null };
		const first = { srcObject: null } as unknown as HTMLVideoElement;
		previewRef(video, stream)(first);
		expect(first.srcObject).toBeNull();
		expect(video.current).toBe(first);
	});
});
