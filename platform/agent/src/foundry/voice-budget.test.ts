import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
	composeSystemPromptParts,
	DOSSIER_ABOUT_MAX,
	DOSSIER_PREFERENCES_MAX,
	IDENTITY_NAME_MAX,
	LIVE_CONTEXT_LINE_MAX,
	LIVE_CONTEXT_MAX_LINES,
	languageDirective,
	type PersonalizationInput,
	renderDossierBlock,
	renderIdentityBlock,
	renderLiveContextBlock,
	renderMemoryBlock,
} from "@platform/prompt";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { DEFAULT_AGENT_SETTINGS } from "../settings";
import { fittedPersonalization, voiceInstructionCap } from "./voice-budget";

const count = (text: string) =>
	countTokens(text, { disallowedSpecial: new Set() });
const INSTRUCTION_CAP = 16_384;

const quiet: ReturnType<typeof spyOn>[] = [];
beforeAll(() => {
	for (const level of ["warn", "error", "log"] as const)
		quiet.push(spyOn(console, level).mockImplementation(() => {}));
});
afterAll(() => {
	for (const spy of quiet) spy.mockRestore();
});

/** Words at about three characters a token, cut to `chars`: denser than prose in any of the product's languages. */
const words = (chars: number) =>
	" xx".repeat(Math.ceil(chars / 3)).slice(0, chars);

/** Every block of the person's part at its cap: the worst case a session can open with. */
function worstBlocks(): PersonalizationInput {
	return {
		today: "2026-11-10",
		identity: renderIdentityBlock({ name: words(IDENTITY_NAME_MAX) }),
		dossier: renderDossierBlock(
			{
				about: words(DOSSIER_ABOUT_MAX),
				preferences: words(DOSSIER_PREFERENCES_MAX),
			},
			"spoken",
		),
		memory: renderMemoryBlock(
			Array.from({ length: 40 }, () => words(200)),
			DEFAULT_AGENT_SETTINGS.memory.maxChars,
		),
		lastConversationAt: "2026-11-01T09:00:00Z",
		liveContext: renderLiveContextBlock(
			Array.from({ length: LIVE_CONTEXT_MAX_LINES }, () =>
				words(LIVE_CONTEXT_LINE_MAX),
			),
		),
		language: languageDirective("Italian", { properNouns: ["Atlas"] }),
	};
}

/** A prompt whose fixed part is the guardrails and a persona `personaTokens` long. */
function prompt(personaTokens: number, blocks = worstBlocks()) {
	return {
		blocks,
		parts: composeSystemPromptParts({
			guardrails: "GUARDRAILS: decline what is unsafe.",
			persona: `# CORE IDENTITY\n${" xx".repeat(personaTokens)}`,
			behaviour: "Speak briefly.",
			personalization: blocks,
		}),
	};
}

test("a speech-to-speech session's instructions are held to the realtime model's 16,384 tokens; the cascade's to none", () => {
	expect(voiceInstructionCap({ engine: "speechToSpeech" })).toBe(
		INSTRUCTION_CAP,
	);
	expect(voiceInstructionCap({ engine: "cascade" })).toBeNull();
});

test("the worst case — every block of the person's part at its cap — fits a speech-to-speech session by leaving whole blocks out in order, never the guardrails, the date or the language", async () => {
	const worst = prompt(14_000);
	const whole = count(`${worst.parts.fixed}\n\n${worst.parts.personalization}`);
	expect(whole).toBeGreaterThan(INSTRUCTION_CAP);
	const personalization = await fittedPersonalization(
		worst,
		INSTRUCTION_CAP,
		count,
	);
	const rendered = `${worst.parts.fixed}\n\n${personalization}`;
	expect(count(rendered)).toBeLessThanOrEqual(INSTRUCTION_CAP);
	expect(rendered).toContain("GUARDRAILS: decline what is unsafe.");
	expect(personalization).toContain("TODAY IS 2026-11-10");
	expect(personalization).toContain(worst.blocks.language as string);
	// What is remembered goes first; who they are, last.
	expect(personalization).not.toContain(worst.blocks.memory as string);
	expect(personalization).toContain(worst.blocks.identity as string);
	const reported = quiet[0]?.mock.calls.at(-1)?.[0];
	expect(String(reported)).toContain("left out: memory");

	// The cascade's are not counted: the same session is given everything the header can carry.
	expect(await fittedPersonalization(worst, null)).toBe(
		worst.parts.personalization,
	);
});

test("on either engine the person's part is held to what the structured-inputs header carries, with every character past ASCII counted as its escape", async () => {
	// What is remembered, in a script the header escapes: six characters each.
	const blocks = {
		...worstBlocks(),
		memory: renderMemoryBlock(
			Array.from({ length: 40 }, () => "記憶".repeat(100)),
			DEFAULT_AGENT_SETTINGS.memory.maxChars,
		),
	};
	const wide = prompt(10, blocks);
	const personalization = await fittedPersonalization(wide, null);
	expect(personalization).not.toContain("記憶");
	expect(personalization).toContain(blocks.identity as string);
	// The worst case in ASCII fits the header whole.
	expect(await fittedPersonalization(prompt(10), null)).toBe(
		prompt(10).parts.personalization,
	);
});

test("a fixed part the cap cannot hold is said so, with every block that can go gone", async () => {
	const huge = prompt(20_000);
	const personalization = await fittedPersonalization(
		huge,
		INSTRUCTION_CAP,
		count,
	);
	expect(personalization).toContain("TODAY IS");
	for (const block of ["memory", "dossier", "identity", "liveContext"] as const)
		expect(personalization).not.toContain(huge.blocks[block] as string);
	expect(
		quiet[1]?.mock.calls.some((call: unknown[]) =>
			String(call[0]).includes("past the 16384-token bound"),
		),
	).toBe(true);
});

test("the shipped tokenizer is the one counted with, loaded on first use", async () => {
	const small = prompt(10);
	expect(await fittedPersonalization(small, INSTRUCTION_CAP)).toBe(
		small.parts.personalization,
	);
});
