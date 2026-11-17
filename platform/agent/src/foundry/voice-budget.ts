import { fitPersonalization } from "@platform/prompt";
import type { TurnPrompt } from "../instructions";
import { problems } from "../keys";
import type { EffectiveVoice } from "./voice-tuning";

/**
 * How large a live session's person's part may be, and what gives way when
 * it would be larger. Two bounds, both known from how the service behaves:
 *
 *   - A speech-to-speech session's rendered instructions — the version's
 *     guardrails, persona and surface with the person's part filled into its
 *     placeholder — are held to the realtime model's cap, 16,384 tokens
 *     ("Instructions cannot be longer than 16384 tokens"), on a
 *     `GlobalStandard` deployment as on the realtime API itself. Past it the
 *     session is refused its instructions as it opens and answers without
 *     them, guardrails included. The cascade's chat model takes far longer
 *     ones.
 *   - The person's part travels in the socket's structured-inputs header,
 *     which the service refuses past a few tens of kilobytes: the handshake
 *     fails on either engine.
 *
 * Counted in `o200k_base`, the realtime models' encoding. Over either bound
 * personalization blocks are left out whole, in `PERSONALIZATION_TRIM_ORDER`
 * (`@platform/prompt`), until it fits: never the guardrails, never the date
 * or the language directive.
 */

/** A realtime model's instructions cap, in tokens. */
const REALTIME_INSTRUCTION_CAP = 16_384;

/**
 * The structured-inputs header the service takes, in characters as sent
 * (`headerJson` in `@platform/voice` escapes every character past ASCII as
 * six): a header of 32,061 opened a session and one of 48,063 was refused,
 * so this keeps under the one measured to work.
 */
const HEADER_MAX_CHARS = 32_000;

/** The cap a session's instructions are held to, or null for one with none known: the cascade. */
export function voiceInstructionCap(
	effective: Pick<EffectiveVoice, "engine">,
): number | null {
	return effective.engine === "speechToSpeech"
		? REALTIME_INSTRUCTION_CAP
		: null;
}

/** The person's part as the header carries it: its JSON, each character past ASCII escaped. */
function headerChars(personalization: string): number {
	let wide = 0;
	for (const c of personalization) if (c.charCodeAt(0) >= 0x7f) wide++;
	return JSON.stringify(personalization).length + wide * 5;
}

type Counter = (text: string) => number;
let counter: Promise<Counter> | null = null;

/** `o200k_base`, loaded the first time a capped session opens: its tables are megabytes no other path needs. */
function o200k(): Promise<Counter> {
	counter ??= import("gpt-tokenizer/encoding/o200k_base").then(
		({ countTokens }) =>
			(text: string) =>
				// Counted as plain text: a prompt quoting a special token's spelling is words, not a control.
				countTokens(text, { disallowedSpecial: new Set() }),
	);
	return counter;
}

/**
 * The person's part a session is opened with: the prompt's own, or, over a
 * bound, with whole blocks left out. Each leaving-out is reported, and so is
 * a part that cannot fit however much is left out.
 */
export async function fittedPersonalization(
	prompt: Pick<TurnPrompt, "parts" | "blocks">,
	cap: number | null,
	count?: Counter,
): Promise<string> {
	const tokens = cap === null ? null : (count ?? (await o200k()));
	const { fixed } = prompt.parts;
	const fitted = fitPersonalization(
		prompt.blocks,
		(personalization) =>
			headerChars(personalization) <= HEADER_MAX_CHARS &&
			(cap === null ||
				tokens === null ||
				tokens(personalization ? `${fixed}\n\n${personalization}` : fixed) <=
					cap),
	);
	const limit = cap ?? HEADER_MAX_CHARS;
	if (fitted.dropped.length) {
		problems.report("agent.voice.personalization_trimmed", {
			reason: fitted.dropped.join(","),
			limit,
		});
		console.warn(
			`[agent] a live session's person's part was over its bound (${cap === null ? `${HEADER_MAX_CHARS}-character header` : `${cap}-token instructions or the header`}); left out: ${fitted.dropped.join(", ")}`,
		);
	}
	if (!fitted.fits) {
		problems.report("agent.voice.instructions_over_cap", { limit });
		console.error(
			`[agent] a live session's instructions do not fit with every personalization block left out: the guardrails, persona and surface alone are past the ${limit}-${cap === null ? "character" : "token"} bound`,
		);
	}
	return fitted.personalization;
}
