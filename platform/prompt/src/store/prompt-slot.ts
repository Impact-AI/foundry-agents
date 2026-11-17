import {
	type ConfigKey,
	defineConfigKey,
	withDeadline,
} from "@platform/config";
import {
	type ContainerDefinition,
	type CosmosDocument,
	cosmosDatabase,
	hasStatus,
	type Stored,
} from "@platform/cosmos";

/**
 * A versioned prompt. Documents sharing a key are its versions, exactly one
 * is active, and reads resolve the active one, so switching it live-swaps
 * what the agent uses. The default text is the product's: the fallback when
 * no version answers, and what a fresh database is seeded with. One document
 * an operator rewrites, which is why a version shadows the default entirely.
 *
 * A version the code wrote carries `source: "shipped"`, so the job can tell
 * the seed from an operator's work: while the latest version is the code's,
 * a change to the default text is published as the next version; the first
 * version an operator publishes ends that, and the default is then only the
 * fallback. A `v1` with no source is the seed too: `publish` seeds before it
 * writes, so no operator's version has ever been labelled `v1`.
 *
 * A key's versions share a partition, so the one-active invariant is kept by
 * a transactional batch: the version that was active is switched off, on
 * the condition that it still carries the etag it was read with, in the same
 * batch that switches the next one on. Two publishes at once cannot both
 * succeed, and neither can leave two versions active or none. A version's
 * id is its label, so a label is unique per key by construction.
 */

export interface PromptDefinition {
	/** The prompt's key. */
	key: string;
	/** What an editor calls it. */
	title: string;
	defaultText: string;
}

export interface PromptVersion {
	label: string;
	chars: number;
}

export interface NamedPrompt {
	id: string;
	label: string;
	text: string;
	isActive: boolean;
}

/** What `sync` did: the first version written, the latest left as it is, the changed default published, or an operator's latest left alone. */
export type PromptSync =
	| { outcome: "seeded" | "unchanged" | "published"; label: string }
	| { outcome: "operator"; label: string; defaultChanged: boolean };

export interface PromptSlot {
	/** The active version's text, or the default when none answers or the database cannot be read. Memoised; never throws. */
	read(): Promise<string>;
	invalidate(): void;
	/** Which version `read` is serving, or null. Uncached: an audit's question, not a turn's. */
	version(): Promise<PromptVersion | null>;
	/** One version by its label, active or not, for grading a draft before it goes live. Null, never a fallback. */
	named(label: string): Promise<NamedPrompt | null>;
	/** Write the default as the first, active version when the key has none. True when it did. */
	seed(): Promise<boolean>;
	/**
	 * Bring the versions up to the default text: seed where there is none;
	 * publish the default as the next `v<n>` where the latest version is the
	 * code's and the text differs; leave an operator's latest alone.
	 */
	sync(): Promise<PromptSync>;
	/** Make `text` the active version, labelled `label`. Throws when the label is taken, or another write won. */
	publish(version: { label: string; text: string }): Promise<void>;
	/** Make the version labelled `label` the active one again. False when there is no such version. */
	activate(label: string): Promise<boolean>;
}

/** The versions of every prompt, partitioned by key. */
const PROMPTS: ContainerDefinition = {
	name: "prompts",
	partitionKey: "/key",
};

/** The containers this package reads, for an app's start to verify and a test to create. */
export const promptContainers: readonly ContainerDefinition[] = [PROMPTS];

interface PromptDocument extends CosmosDocument {
	key: string;
	title: string;
	prompt: string;
	label: string;
	isActive: boolean;
	createdAt: string;
	/** `shipped` on a version the code wrote; absent on an operator's. */
	source?: "shipped";
}

/** The label the default is seeded under; the versions `sync` publishes count on from it. */
const SEED_LABEL = "v1";

/** A version the code wrote: by its mark, or by the one label only the seed has ever had. */
const isShipped = (version: PromptDocument) =>
	version.source === "shipped" ||
	(version.source === undefined && version.label === SEED_LABEL);

/** A label is a document id: none of the four characters an id may not hold, nor a control character. */
const LABEL = /^[^/\\?#\p{Cc}]{1,64}$/u;

/**
 * How long a turn waits for the active version before it is answered from the
 * memo or the default. The read is in the path of every turn whose memo has
 * expired, and the database's own request timeout and retries are far longer.
 */
const ACTIVE_READ_TIMEOUT_MS = 2_000;

const prompts = () => cosmosDatabase().container(PROMPTS.name);

export function definePrompt(definition: PromptDefinition): PromptSlot {
	const { key, title, defaultText } = definition;

	const active = async (): Promise<Stored<PromptDocument> | null> => {
		const [found] = await prompts().query<PromptDocument>(
			{ query: "SELECT * FROM c WHERE c.isActive = true" },
			key,
		);
		return found ?? null;
	};

	const document = (
		label: string,
		text: string,
		source?: "shipped",
	): PromptDocument => ({
		id: label,
		key,
		title,
		prompt: text,
		label,
		isActive: true,
		createdAt: new Date().toISOString(),
		...(source ? { source } : {}),
	});

	const memo: ConfigKey<string> = defineConfigKey<string>({
		key: `prompt:${key}`,
		defaultValue: defaultText,
		parse: (stored) =>
			typeof stored === "string" && stored.trim() ? stored.trim() : defaultText,
		read: async () =>
			(
				await withDeadline(
					() => active(),
					ACTIVE_READ_TIMEOUT_MS,
					() =>
						new Error(
							`the active "${key}" prompt did not answer within ${ACTIVE_READ_TIMEOUT_MS}ms`,
						),
				)
			)?.prompt ?? null,
	});

	/** Make `text` the active version, labelled `label`, marked `source` when the code wrote it. */
	const write = async (
		label: string,
		text: string,
		source?: "shipped",
	): Promise<void> => {
		const trimmed = label.trim();
		if (!LABEL.test(trimmed))
			throw new Error(
				`"${label}" is not a label: 1 to 64 characters, none of / \\ ? #`,
			);
		if (!text.trim()) throw new Error("a version needs text");
		// The batch switches off the version that is active; a key with
		// none yet gets the default first, so there always is one.
		await slot.seed();
		const current = await active();
		if (!current) throw new Error(`prompt "${key}" has no active version`);
		try {
			await prompts().batch(key, [
				{
					type: "patch",
					id: current.id,
					operations: [{ op: "set", path: "/isActive", value: false }],
					ifMatch: current._etag,
				},
				{ type: "create", document: document(trimmed, text, source) },
			]);
		} catch (err) {
			if (hasStatus(err, 409))
				throw new Error(`prompt "${key}" has a version "${trimmed}" already`);
			if (hasStatus(err, 412))
				throw new Error(
					`prompt "${key}" changed while publishing "${trimmed}"; nothing was written`,
				);
			throw err;
		} finally {
			memo.invalidate();
		}
	};

	const slot: PromptSlot = {
		read: () => memo.read(),
		invalidate: () => memo.invalidate(),

		async version() {
			try {
				const found = await active();
				return found
					? { label: found.label, chars: found.prompt.length }
					: null;
			} catch (err) {
				console.error(`prompt "${key}": no version to report:`, err);
				return null;
			}
		},

		async named(label) {
			if (!LABEL.test(label)) return null;
			const found = await prompts().read<PromptDocument>(label, key);
			return found
				? {
						id: found.id,
						label: found.label,
						text: found.prompt,
						isActive: found.isActive,
					}
				: null;
		},

		async seed() {
			const [any] = await prompts().query<PromptDocument>(
				{ query: "SELECT TOP 1 * FROM c" },
				key,
			);
			if (any) return false;
			try {
				await prompts().create(document(SEED_LABEL, defaultText, "shipped"));
				return true;
			} catch (err) {
				// Another seed, or a first publish, made it first.
				if (hasStatus(err, 409)) return false;
				throw err;
			}
		},

		async sync() {
			const versions = await prompts().query<PromptDocument>(
				{ query: "SELECT * FROM c ORDER BY c.createdAt DESC" },
				key,
			);
			const latest = versions[0];
			if (!latest) {
				await slot.seed();
				return { outcome: "seeded", label: SEED_LABEL };
			}
			if (!isShipped(latest))
				return {
					outcome: "operator",
					label: latest.label,
					defaultChanged: latest.prompt !== defaultText,
				};
			if (latest.prompt === defaultText)
				return { outcome: "unchanged", label: latest.label };
			const taken = new Set(versions.map((version) => version.label));
			let next = versions.length + 1;
			while (taken.has(`v${next}`)) next += 1;
			const label = `v${next}`;
			await write(label, defaultText, "shipped");
			return { outcome: "published", label };
		},

		publish: ({ label, text }) => write(label, text),

		async activate(label) {
			const target = LABEL.test(label)
				? await prompts().read<PromptDocument>(label, key)
				: null;
			if (!target) return false;
			if (target.isActive) return true;
			const current = await active();
			const switchOff = current
				? [
						{
							type: "patch" as const,
							id: current.id,
							operations: [
								{ op: "set" as const, path: "/isActive", value: false },
							],
							ifMatch: current._etag,
						},
					]
				: [];
			try {
				await prompts().batch(key, [
					...switchOff,
					{
						type: "patch",
						id: target.id,
						operations: [{ op: "set", path: "/isActive", value: true }],
						ifMatch: target._etag,
					},
				]);
			} catch (err) {
				if (hasStatus(err, 412))
					throw new Error(
						`prompt "${key}" changed while activating "${label}"; nothing was written`,
					);
				throw err;
			} finally {
				memo.invalidate();
			}
			return true;
		},
	};
	return slot;
}
