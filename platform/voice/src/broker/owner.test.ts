import { expect, spyOn, test } from "bun:test";
import type { ServerEvent } from "../voicelive/events";
import { type OwnedSession, type OwnerDeps, SessionOwner } from "./owner";

/**
 * The owner's bookkeeping of an open response's audio, on events alone:
 * the owner is never handed a socket here, so nothing is sent or kept.
 */
function owner(): SessionOwner {
	const session = {
		id: "session-1",
		surface: "voice",
		idleSeconds: 0,
		binding: { agentName: "sample", version: "1" },
		store: { keepSpoken: async () => {} },
	} as unknown as OwnedSession;
	const browser = { send() {}, audio: () => true, close() {} };
	return new SessionOwner(session, browser, {} as OwnerDeps);
}

const audio = (response_id?: string) =>
	({
		type: "response.output_audio.delta",
		delta: "",
		...(response_id ? { response_id } : {}),
	}) as unknown as ServerEvent;
const created = (id: string) =>
	({ type: "response.created", response: { id } }) as unknown as ServerEvent;
const done = (id: string) =>
	({
		type: "response.done",
		response: { id, status: "completed", usage: null },
	}) as unknown as ServerEvent;
const spoke = (o: SessionOwner) =>
	(o as unknown as { spoke: Map<string, number> }).spoke;

test("audio without a response id, before any response or after the last one is done, leaves nothing behind", () => {
	const quiet = spyOn(console, "log").mockImplementation(() => {});
	try {
		const o = owner();
		o.observe(audio());
		expect(spoke(o).size).toBe(0);

		o.observe(created("resp_1"));
		o.observe(audio());
		expect([...spoke(o).keys()]).toEqual(["resp_1"]);
		o.observe(done("resp_1"));
		expect(spoke(o).size).toBe(0);

		// Late audio of a response already done, by its id or by none.
		o.observe(audio());
		o.observe(audio("resp_1"));
		expect(spoke(o).size).toBe(0);
	} finally {
		quiet.mockRestore();
	}
});
