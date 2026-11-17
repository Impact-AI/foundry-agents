import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { TurnClock, VOICE_TURN_EVENT, type VoiceTurnLine } from "./turn-timing";

let log: ReturnType<typeof spyOn>;
beforeEach(() => {
	log = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => log.mockRestore());

/** The turn lines written so far. */
function written(): VoiceTurnLine[] {
	return log.mock.calls.flatMap((call: unknown[]) => {
		try {
			const line = JSON.parse(String(call[0])) as VoiceTurnLine;
			return line.evt === VOICE_TURN_EVENT ? [line] : [];
		} catch {
			return [];
		}
	});
}

/** A clock a test moves by hand. */
function clock() {
	let at = 0;
	const turns = new TurnClock(
		{ id: "session-1", surface: "live", model: "assistant-voice:3" },
		() => at,
	);
	return {
		turns,
		to(ms: number) {
			at = ms;
		},
	};
}

test("a spoken turn's waits run from the end of the person's speech: to the voice's first audio, to the answer's, and each tool's time by name", () => {
	const { turns, to } = clock();
	to(1_000);
	turns.heard();
	to(1_040);
	turns.begin("spoken");
	turns.response();
	to(1_400);
	turns.audio(false);
	to(1_500);
	turns.called("call_1", "knowledgeSearch");
	turns.called("call_2", "openDocument");
	to(1_530);
	turns.returned("call_2");
	to(2_100);
	turns.returned("call_1");
	turns.response();
	to(2_650.04);
	turns.audio(true);
	// The answer's later audio moves nothing.
	to(3_000);
	turns.audio(true);
	expect(written()).toEqual([]);
	turns.close();
	expect(written()).toEqual([
		{
			evt: "voice_turn",
			ts: expect.any(String),
			turnId: "session-1",
			surface: "live",
			model: "assistant-voice:3",
			how: "spoken",
			firstAudioMs: 400,
			answerAudioMs: 1_650,
			responses: 2,
			toolMs: { knowledgeSearch: 600, openDocument: 30 },
			bargedIn: false,
			outcome: "answered",
		},
	]);
});

test("a typed turn's wait runs from its words arriving, and the next turn writes the one before", () => {
	const { turns, to } = clock();
	to(500);
	turns.heard();
	to(9_000);
	turns.begin("typed");
	turns.response();
	to(9_800);
	turns.audio(true);
	to(12_000);
	turns.spokenOver();
	turns.heard();
	turns.begin("spoken");
	expect(written()).toMatchObject([
		{
			how: "typed",
			firstAudioMs: 800,
			answerAudioMs: 800,
			responses: 1,
			bargedIn: true,
			outcome: "answered",
		},
	]);
	turns.close();
	turns.close();
	expect(written()).toHaveLength(2);
	expect(written()[1]).toMatchObject({
		how: "spoken",
		firstAudioMs: null,
		answerAudioMs: null,
		responses: 0,
		outcome: "silent",
	});
});

test("a turn the filter stopped, or that could not be answered, says so; a filler alone is not an answer", () => {
	const { turns, to } = clock();
	turns.begin("spoken");
	to(300);
	turns.audio(true);
	turns.ended("blocked");
	turns.begin("spoken");
	to(700);
	turns.audio(false);
	turns.ended("unanswered");
	turns.begin("typed");
	to(900);
	turns.audio(false);
	turns.close();
	expect(written().map((line) => [line.outcome, line.answerAudioMs])).toEqual([
		["blocked", 300],
		["unanswered", null],
		["silent", null],
	]);
});

test("nothing is written outside a turn, and a tool's answer after its turn is counted nowhere", () => {
	const { turns, to } = clock();
	turns.response();
	turns.audio(true);
	turns.called("call_0", "knowledgeSearch");
	turns.close();
	expect(written()).toEqual([]);
	turns.begin("typed");
	turns.called("call_1", "knowledgeSearch");
	to(50);
	// The person speaks again before the tool answers: its time is not the next turn's.
	turns.begin("spoken");
	to(400);
	turns.returned("call_0");
	turns.returned("call_1");
	turns.returned("call_unknown");
	turns.close();
	expect(written().map((line) => line.toolMs)).toEqual([{}, {}]);
});

test("a call never answered is let go with the turn that made it, and an open turn's call is kept until its turn is written", () => {
	const { turns, to } = clock();
	const held = () =>
		(turns as unknown as { calls: Map<string, unknown> }).calls;
	turns.begin("typed");
	turns.called("call_lost", "knowledgeSearch");
	turns.begin("typed");
	expect([...held().keys()]).toEqual([]);
	turns.called("call_open", "openDocument");
	expect([...held().keys()]).toEqual(["call_open"]);
	to(100);
	turns.close();
	expect([...held().keys()]).toEqual([]);
	// The lost call's answer, arriving after all, is counted nowhere.
	turns.returned("call_lost");
	expect(written().map((line) => line.toolMs)).toEqual([{}, {}]);
});
