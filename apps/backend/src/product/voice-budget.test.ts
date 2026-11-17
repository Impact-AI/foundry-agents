import { expect, test } from "bun:test";
import { DEFAULT_AGENT_SETTINGS } from "@platform/agent";
import {
	composeSystemPromptParts,
	DEFAULT_PERSONA_BUDGET,
	DOSSIER_ABOUT_MAX,
	DOSSIER_PREFERENCES_MAX,
	IDENTITY_NAME_MAX,
	LIVE_CONTEXT_LINE_MAX,
	LIVE_CONTEXT_MAX_LINES,
	languageDirective,
	renderDossierBlock,
	renderIdentityBlock,
	renderLiveContextBlock,
	renderMemoryBlock,
} from "@platform/prompt";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { guardrails, product } from "../product";
import { locales } from "./locales";
import { liveBehaviour } from "./voice";

/**
 * This product's live session, at its worst, against a speech-to-speech
 * session's instruction cap (16,384 tokens): the spoken guardrails at their defaults, the live
 * surface with every tool on, a persona as long as the console lets one be,
 * and every block of the person's part at its cap, in the language whose
 * directive is longest. It fits with nothing left out, so the backend's
 * trimming (`voice-budget.ts` in `@platform/agent`) is a guard, not the
 * everyday path.
 */

const INSTRUCTION_CAP = 16_384;
const count = (text: string) =>
	countTokens(text, { disallowedSpecial: new Set() });
/** About three characters a token: denser than prose in any of the product's languages. */
const words = (chars: number) =>
	" xx".repeat(Math.ceil(chars / 3)).slice(0, chars);

test("the worst case of a live session's instructions fits a speech-to-speech session whole", () => {
	const languages = locales.codes.map((code) =>
		languageDirective(locales.languageName(code), {
			properNouns: product.properNouns,
		}),
	);
	const language = languages.reduce((a, b) => (b.length > a.length ? b : a));
	// A persona as long as the console lets one be: the shipped one is far shorter.
	const persona = words(DEFAULT_PERSONA_BUDGET);
	const parts = composeSystemPromptParts({
		guardrails: guardrails.render("spoken"),
		persona,
		behaviour: liveBehaviour({ enabledTools: [...product.toolKeys] }),
		personalization: {
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
			language,
		},
	});
	const tokens = count(`${parts.fixed}\n\n${parts.personalization}`);
	expect(tokens).toBeLessThanOrEqual(INSTRUCTION_CAP);
});
