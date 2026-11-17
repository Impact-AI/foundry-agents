import type { Section } from "./stage";

/**
 * The next steps under the composer, always three. The assistant authors
 * them with `suggestNext` at the end of a turn; when a turn ends without the
 * call, or over an empty thread, the catalogue's openers stand in, chosen by
 * what is on the stage so the row is about what is in front of the person.
 * The keys are resolved here; the component translates them.
 */
export const CHIP_COUNT = 3;

const OPENER_KEYS = ["library", "record", "chart"] as const;

/** A follow-up for each section the stage can hold, and one for an empty stage. */
const FOLLOW_UP_KEYS: Record<Section | "empty", readonly string[]> = {
	library: ["openFirst", "narrowLibrary"],
	reader: ["summarise", "relatedRecords"],
	media: ["describeMedia", "moreLike"],
	chart: ["explainChart", "compareYear"],
	record: ["recordLinks", "recordChart"],
	records: ["record", "chart"],
	empty: ["library", "record"],
};

export interface ChipPlan {
	/** The assistant's own words, verbatim. */
	authored: string[];
	/** Catalogue keys under `suggest.*`, filling what the assistant left. */
	keys: string[];
}

/**
 * What the row offers: the authored asks first, then catalogue keys until
 * there are three — openers over an empty thread, section follow-ups after
 * a turn — and a door out (an opener from a section not on the stage) last,
 * so the conversation never tightens around one subject.
 */
export function planChips(input: {
	authored: readonly string[];
	empty: boolean;
	sections: readonly Section[];
}): ChipPlan {
	const authored = input.authored
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, CHIP_COUNT);
	const keys: string[] = [];
	const want = CHIP_COUNT - authored.length;
	if (want <= 0) return { authored, keys };

	const pool: string[] = [];
	if (input.empty || input.sections.length === 0) {
		pool.push(...FOLLOW_UP_KEYS.empty);
	} else {
		for (const section of input.sections) pool.push(...FOLLOW_UP_KEYS[section]);
	}
	const door = OPENER_KEYS.find((k) => !input.sections.includes(k as Section));
	if (door) pool.push(door);
	for (const key of pool) {
		if (keys.length >= want) break;
		if (!keys.includes(key)) keys.push(key);
	}
	return { authored, keys };
}
