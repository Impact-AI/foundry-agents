import { defineConfigKey, withDeadline } from "@platform/config";
import {
	type BatchOperation,
	type CosmosDocument,
	cosmosDatabase,
	hasStatus,
	type Stored,
} from "@platform/cosmos";

/**
 * The skills, versioned in the `prompts` container beside the persona: the
 * procedures behind the questions that need one, which a turn lists and the
 * model reads on demand. Every version of every skill is a document of the
 * one partition {@link SKILLS_KEY}, so the active versions are one query.
 * Each skill has exactly one active version, kept so by a transactional
 * batch as the persona's is; a version is immutable, and a change — the
 * words, the gating, the switch — is a new one.
 *
 * The product's defaults only seed: the job writes a default whose name has
 * no version at all, so a change to one in code reaches a new deployment
 * and never a running one, where the operator owns the skill. `reset`
 * publishes the default again, on purpose. The defaults are also what turns
 * carry while no skill is stored or the database cannot be read.
 */

/** A skill as the product ships it, and as a turn carries it. */
export interface SkillDefault {
	name: string;
	/** "Use when…": the whole basis for reading it. */
	description: string;
	instructions: string;
	/** Offered only on these surfaces; none means all of them. */
	surfaces?: readonly string[];
	/** Offered only when at least one of these tool keys is enabled; none means always. */
	requiresTools?: readonly string[];
}

/** What one version holds. */
export interface SkillContent {
	description: string;
	instructions: string;
	surfaces: readonly string[];
	requiresTools: readonly string[];
	/** Off, no turn carries it; the version stays active, so turning it on again is one more version. */
	enabled: boolean;
}

/** A skill's active version, as the CLI lists it. */
export interface SkillVersion extends SkillContent {
	name: string;
	label: string;
	/** `shipped` when the code wrote it (the seed, or a reset); `custom` when an operator did. */
	origin: "shipped" | "custom";
	createdAt: string;
}

export interface SkillStore {
	/** The active, enabled versions, or the defaults while none is stored or the database cannot be read. Memoised; never throws. */
	read(): Promise<SkillDefault[]>;
	invalidate(): void;
	/** Every skill's active version, enabled or not. Uncached, and throws: an operator's question. */
	list(): Promise<SkillVersion[]>;
	/** Write each default whose name has no version, as its active `v1`. The names written. */
	seed(): Promise<string[]>;
	/** A new version of `name`, active when `activate` or when the skill had none. Its label. */
	publish(
		name: string,
		content: SkillContent,
		options?: { activate?: boolean; origin?: "shipped" | "custom" },
	): Promise<string>;
	/** Make an existing version the active one. False when there is no such version. */
	activate(name: string, label: string): Promise<boolean>;
	/** The active version again with `enabled` set, as a new active version; null when it is already so. */
	setEnabled(name: string, enabled: boolean): Promise<string | null>;
	/** The default publish again as the active version. Throws when the product ships no such skill. */
	reset(name: string): Promise<string>;
}

/** The partition of the `prompts` container the skills are kept in. */
const SKILLS_KEY = "skills";

interface SkillDocument extends CosmosDocument {
	key: typeof SKILLS_KEY;
	name: string;
	label: string;
	description: string;
	/** The instructions, under the field the container leaves out of its index. */
	prompt: string;
	surfaces: string[];
	requiresTools: string[];
	enabled: boolean;
	origin: "shipped" | "custom";
	isActive: boolean;
	createdAt: string;
}

/** A skill's name: what the model reads it by, and half of a document id. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const READ_TIMEOUT_MS = 2_000;

/** The persona's container: `promptContainers` declares it, so the template and the tests make it already. */
const container = () => cosmosDatabase().container("prompts");

const asDefault = (doc: SkillDocument): SkillDefault => ({
	name: doc.name,
	description: doc.description,
	instructions: doc.prompt,
	surfaces: doc.surfaces,
	requiresTools: doc.requiresTools,
});

const asVersion = (doc: SkillDocument): SkillVersion => ({
	name: doc.name,
	label: doc.label,
	origin: doc.origin,
	createdAt: doc.createdAt,
	description: doc.description,
	instructions: doc.prompt,
	surfaces: doc.surfaces,
	requiresTools: doc.requiresTools,
	enabled: doc.enabled,
});

function checkName(name: string): void {
	if (!NAME.test(name))
		throw new Error(
			`"${name}" is not a skill name: lowercase letters, digits and hyphens, to 64 characters`,
		);
}

export function defineSkills(defaults: readonly SkillDefault[]): SkillStore {
	const active = () =>
		container().query<SkillDocument>(
			{ query: "SELECT * FROM c WHERE c.isActive = true" },
			SKILLS_KEY,
		);

	const versionsOf = (name: string) =>
		container().query<SkillDocument>(
			{
				query: "SELECT * FROM c WHERE c.name = @name",
				parameters: [{ name: "@name", value: name }],
			},
			SKILLS_KEY,
		);

	const memo = defineConfigKey<SkillDefault[]>({
		key: "prompt:skills",
		defaultValue: [...defaults],
		parse: (stored) =>
			(stored as SkillDocument[])
				.filter((doc) => doc.enabled)
				.map(asDefault)
				.sort((a, b) => a.name.localeCompare(b.name)),
		read: async () => {
			const found = await withDeadline(
				() => active(),
				READ_TIMEOUT_MS,
				() =>
					new Error(`the skills did not answer within ${READ_TIMEOUT_MS}ms`),
			);
			return found.length ? found : null;
		},
	});

	/** Switch `next` on and whatever is active of the skill off, in one batch. */
	const switchTo = async (
		name: string,
		next: BatchOperation,
		current: Stored<SkillDocument> | undefined,
	) => {
		try {
			await container().batch(SKILLS_KEY, [
				...(current
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
					: []),
				next,
			]);
		} catch (err) {
			if (hasStatus(err, 409) || hasStatus(err, 412))
				throw new Error(
					`skill "${name}" changed while it was written; nothing was written`,
				);
			throw err;
		} finally {
			memo.invalidate();
		}
	};

	const store: SkillStore = {
		read: () => memo.read(),
		invalidate: () => memo.invalidate(),

		async list() {
			return (await active())
				.map(asVersion)
				.sort((a, b) => a.name.localeCompare(b.name));
		},

		async seed() {
			const written: string[] = [];
			for (const skill of defaults) {
				checkName(skill.name);
				if ((await versionsOf(skill.name)).length) continue;
				try {
					await store.publish(skill.name, contentOf(skill), {
						origin: "shipped",
					});
					written.push(skill.name);
				} catch (err) {
					// Another seed, or an operator's first version, made it first.
					if (!(await versionsOf(skill.name)).length) throw err;
				}
			}
			return written;
		},

		async publish(name, content, options = {}) {
			checkName(name);
			if (!content.description.trim())
				throw new Error(`skill "${name}" needs a description`);
			if (!content.instructions.trim())
				throw new Error(`skill "${name}" needs instructions`);
			const versions = await versionsOf(name);
			const current = versions.find((doc) => doc.isActive);
			const activate = options.activate === true || !current;
			const taken = new Set(versions.map((doc) => doc.label));
			let next = versions.length + 1;
			while (taken.has(`v${next}`)) next += 1;
			const label = `v${next}`;
			const document: SkillDocument = {
				id: `${name}@${label}`,
				key: SKILLS_KEY,
				name,
				label,
				description: content.description.trim(),
				prompt: content.instructions.trim(),
				surfaces: [...content.surfaces],
				requiresTools: [...content.requiresTools],
				enabled: content.enabled,
				origin: options.origin ?? "custom",
				isActive: activate,
				createdAt: new Date().toISOString(),
			};
			await switchTo(
				name,
				{ type: "create", document },
				activate ? current : undefined,
			);
			return label;
		},

		async activate(name, label) {
			const versions = NAME.test(name) ? await versionsOf(name) : [];
			const target = versions.find((doc) => doc.label === label);
			if (!target) return false;
			if (target.isActive) return true;
			await switchTo(
				name,
				{
					type: "patch",
					id: target.id,
					operations: [{ op: "set", path: "/isActive", value: true }],
					ifMatch: target._etag,
				},
				versions.find((doc) => doc.isActive),
			);
			return true;
		},

		async setEnabled(name, enabled) {
			const current = NAME.test(name)
				? (await versionsOf(name)).find((doc) => doc.isActive)
				: undefined;
			if (!current) throw new Error(`there is no skill "${name}"`);
			if (current.enabled === enabled) return null;
			return store.publish(
				name,
				{ ...asVersion(current), enabled },
				{ activate: true },
			);
		},

		async reset(name) {
			const shipped = defaults.find((skill) => skill.name === name);
			if (!shipped)
				throw new Error(
					`the product ships no skill "${name}": only a shipped skill is reset`,
				);
			return store.publish(name, contentOf(shipped), {
				activate: true,
				origin: "shipped",
			});
		},
	};
	return store;
}

function contentOf(skill: SkillDefault): SkillContent {
	return {
		description: skill.description,
		instructions: skill.instructions,
		surfaces: skill.surfaces ?? [],
		requiresTools: skill.requiresTools ?? [],
		enabled: true,
	};
}
