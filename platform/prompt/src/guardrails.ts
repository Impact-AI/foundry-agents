import type { ReplyChannel } from "./personalization";
import { scrubQuotedText } from "./scrub";

/**
 * Guardrails assembled from slots. An operator edits a slot; the code owns
 * everything else: that the block exists, that it overrides the persona, that
 * a refusal is the whole answer. Three properties hold for every product that
 * uses this: a slot can be retuned but not emptied (a required slot that
 * arrives blank, over-length or of the wrong type falls back to its own
 * default, not to nothing); a slot cannot write prompt (every value is
 * scrubbed); absent configuration renders the shipped block byte for byte.
 */

export interface GuardrailSlotSpec<Key extends string = string> {
	key: Key;
	/** What an operator's screen calls it. */
	label: string;
	/** One line telling an operator what changing it does. */
	purpose: string;
	/** A list of lines rather than one passage. */
	list: boolean;
	/** Whether an empty value falls back to the default, or is a legitimate "nothing". */
	required: boolean;
	/** Characters per value, or per item of a list. */
	max: number;
	maxItems?: number;
}

export type GuardrailValues<Key extends string> = Record<
	Key,
	string | readonly string[]
>;

export type GuardrailOverrides<Key extends string> = Partial<
	Record<Key, unknown>
>;

export interface GuardrailSlotRejection<Key extends string> {
	key: Key;
	reason: "not-text" | "empty" | "too-long" | "too-many";
}

export interface ResolvedGuardrails<
	Key extends string,
	Values extends GuardrailValues<Key>,
> {
	resolved: Values;
	rejected: GuardrailSlotRejection<Key>[];
}

/** The overrides folded over the defaults, per slot, never all-or-nothing. */
export function resolveGuardrailSlots<
	Key extends string,
	Values extends GuardrailValues<Key>,
>(
	slots: readonly GuardrailSlotSpec<Key>[],
	defaults: Values,
	overrides?: GuardrailOverrides<Key> | null,
): ResolvedGuardrails<Key, Values> {
	const resolved = { ...defaults } as Record<
		string,
		string | readonly string[]
	>;
	const rejected: GuardrailSlotRejection<Key>[] = [];
	if (!overrides || typeof overrides !== "object") {
		return { resolved: resolved as Values, rejected };
	}
	for (const spec of slots) {
		const raw = (overrides as Record<string, unknown>)[spec.key];
		if (raw === undefined || raw === null) continue;
		if (spec.list) {
			const items = resolveList(spec, raw, rejected);
			if (items) resolved[spec.key] = items;
			continue;
		}
		if (typeof raw !== "string") {
			rejected.push({ key: spec.key, reason: "not-text" });
			continue;
		}
		const clean = scrubQuotedText(raw, Number.POSITIVE_INFINITY);
		if (!clean) {
			if (spec.required) rejected.push({ key: spec.key, reason: "empty" });
			else resolved[spec.key] = "";
			continue;
		}
		if (clean.length > spec.max) {
			rejected.push({ key: spec.key, reason: "too-long" });
			continue;
		}
		resolved[spec.key] = clean;
	}
	return { resolved: resolved as Values, rejected };
}

function resolveList<Key extends string>(
	spec: GuardrailSlotSpec<Key>,
	raw: unknown,
	rejected: GuardrailSlotRejection<Key>[],
): string[] | null {
	if (!Array.isArray(raw)) {
		rejected.push({ key: spec.key, reason: "not-text" });
		return null;
	}
	if (spec.maxItems && raw.length > spec.maxItems) {
		rejected.push({ key: spec.key, reason: "too-many" });
		return null;
	}
	const items: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") {
			rejected.push({ key: spec.key, reason: "not-text" });
			return null;
		}
		const clean = scrubQuotedText(item, Number.POSITIVE_INFINITY);
		if (clean && clean.length > spec.max) {
			rejected.push({ key: spec.key, reason: "too-long" });
			return null;
		}
		if (clean) items.push(clean);
	}
	if (!items.length && spec.required) {
		rejected.push({ key: spec.key, reason: "empty" });
		return null;
	}
	return items;
}

/** Lines as bullets with the code's punctuation, whatever an operator typed. */
export function bullets(lines: readonly string[]): string {
	return lines
		.map((line, i) => {
			const text = line.replace(/[.;,]\s*$/, "");
			return `- ${text}${i === lines.length - 1 ? "." : ";"}`;
		})
		.join("\n");
}

export interface GuardrailDefinition<
	Key extends string,
	Values extends GuardrailValues<Key>,
> {
	slots: readonly GuardrailSlotSpec<Key>[];
	defaults: Values;
	/** The code-owned frame around the resolved slots. */
	render: (values: Values, channel: ReplyChannel) => string;
}

export interface Guardrails<
	Key extends string,
	Values extends GuardrailValues<Key>,
> {
	slots: readonly GuardrailSlotSpec<Key>[];
	defaults: Values;
	resolve(
		overrides?: GuardrailOverrides<Key> | null,
	): ResolvedGuardrails<Key, Values>;
	/** The block, from the overrides folded over the defaults. Never throws on a bad configuration. */
	render(
		channel?: ReplyChannel,
		overrides?: GuardrailOverrides<Key> | null,
	): string;
}

export function defineGuardrails<
	Key extends string,
	Values extends GuardrailValues<Key>,
>(definition: GuardrailDefinition<Key, Values>): Guardrails<Key, Values> {
	return {
		slots: definition.slots,
		defaults: definition.defaults,
		resolve: (overrides) =>
			resolveGuardrailSlots(definition.slots, definition.defaults, overrides),
		render: (channel = "written", overrides) =>
			definition.render(
				resolveGuardrailSlots(definition.slots, definition.defaults, overrides)
					.resolved,
				channel,
			),
	};
}
