/**
 * The directive that settles the language, placed after every English block it
 * has to outrank. The model is handed English on every turn — instructions,
 * tool results, live context, retrieved passages — and reasons from it unless
 * told not to. `languageName` is the language's English name (`@platform/i18n`
 * answers it for a locale), never a code. The translation paragraph is skipped
 * for English, where there is nothing to say.
 */
export function languageDirective(
	languageName: string,
	options: { properNouns?: readonly string[] } = {},
): string {
	const nouns = options.properNouns?.length
		? ` Names keep their own spelling — ${options.properNouns.join(", ")}.`
		: "";
	const translating =
		languageName === "English"
			? ""
			: `\n\nEverything handed to you this turn is in English whatever they read in: your own instructions, what your tools report back, the live context from their screen, and the passages your sources return. It is not what the person asked for, and it is never a reason to answer in English, to apologise for a source, or to tell them something cannot be said in ${languageName}. Read it in English; answer in ${languageName}.${nouns}`;
	return `<person_language>
The person has set this interface to ${languageName}. Write ${languageName} from your first word and for the whole conversation: every reply, greeting and refusal, and the line beside anything you put on screen.${translating}

Do not switch because a name or a number looked like another language. Switch only if they ask you to in so many words.
</person_language>`;
}
