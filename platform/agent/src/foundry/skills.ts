import type { ProductTurn, SkillSource } from "../contract/product";
import { skillFitsTurn } from "../skills/skills";
import { hasStatus, projectClient } from "./client";
import { unzip } from "./zip";

/**
 * Skills on Foundry (preview), managed in the project: every skill there is
 * one a turn may carry, versioned by the service, and the default version
 * of each is what agent versions pin. The product's catalogue in code only
 * seeds them (`publishSkills`), and is what a turn falls back to when the
 * project's skills cannot be listed.
 *
 * What gating needs rides in each version's metadata ({@link SkillMeta}),
 * which the service writes into the `metadata` of the version folder's
 * `SKILL.md` front matter. The service's skill objects carry none (2.10.0
 * reads back a name, a description and versions), so the default version's
 * folder is read, once per version: versions are immutable.
 */

/** The metadata keys a version carries. Each value is a string; a list is comma-separated. */
const META = {
	origin: "origin",
	hash: "content-hash",
	enabled: "enabled",
	surfaces: "surfaces",
	requiresTools: "requires-tools",
} as const;

/**
 * A version's gating and provenance. A key a version does not carry reads
 * as no restriction: all surfaces, no tool required, enabled. That is how a
 * skill made in the portal with none of this metadata reads, and it is the
 * operator's to use. `origin` is `shipped` only on a version the job
 * published from the catalogue; anything else is the operator's.
 */
export interface SkillMeta {
	surfaces: string[];
	requiresTools: string[];
	enabled: boolean;
	origin: "shipped" | "custom" | null;
	hash: string | null;
}

export function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function skillMeta(
	metadata: Readonly<Record<string, string>>,
): SkillMeta {
	const origin = metadata[META.origin];
	return {
		surfaces: splitList(metadata[META.surfaces]),
		requiresTools: splitList(metadata[META.requiresTools]),
		enabled: metadata[META.enabled]?.trim() !== "false",
		origin: origin === "shipped" || origin === "custom" ? origin : null,
		hash: metadata[META.hash] || null,
	};
}

/** The metadata a version is published with; an empty list is left out, which reads the same. */
function metadataOf(meta: SkillMeta): Record<string, string> {
	return {
		...(meta.origin ? { [META.origin]: meta.origin } : {}),
		...(meta.hash ? { [META.hash]: meta.hash } : {}),
		[META.enabled]: String(meta.enabled),
		...(meta.surfaces.length
			? { [META.surfaces]: meta.surfaces.join(",") }
			: {}),
		...(meta.requiresTools.length
			? { [META.requiresTools]: meta.requiresTools.join(",") }
			: {}),
	};
}

/** A `SKILL.md`, read: its front matter's name, description and metadata, and the body after it. */
export interface SkillFile {
	name: string | null;
	description: string | null;
	metadata: Record<string, string>;
	body: string;
}

function unquote(value: string): string {
	const v = value.trim();
	return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/**
 * The front matter as the service writes it and an operator would: flat
 * `key: value` lines and a `metadata:` map, indented or as one `{…}` flow.
 * Enough YAML for that, not the language.
 */
export function readSkillFile(text: string): SkillFile {
	const normalised = text.replace(/\r\n/g, "\n");
	const front = /^---\n([\s\S]*?)\n---(\n|$)/.exec(normalised);
	const file: SkillFile = {
		name: null,
		description: null,
		metadata: {},
		body: (front ? normalised.slice(front[0].length) : normalised).trim(),
	};
	let inMetadata = false;
	for (const line of (front?.[1] ?? "").split("\n")) {
		const pair = /^(\s*)([A-Za-z0-9_.-]+):(.*)$/.exec(line);
		if (!pair) continue;
		const [, indent = "", key = "", value = ""] = pair;
		if (indent && inMetadata) {
			file.metadata[key] = unquote(value);
			continue;
		}
		inMetadata = false;
		if (key === "name") file.name = unquote(value);
		else if (key === "description") file.description = unquote(value);
		else if (key === "metadata") {
			const flow = value.trim();
			if (!flow) inMetadata = true;
			else if (flow.startsWith("{"))
				for (const entry of flow.slice(1, -1).split(",")) {
					const at = entry.indexOf(":");
					if (at > 0)
						file.metadata[unquote(entry.slice(0, at))] = unquote(
							entry.slice(at + 1),
						);
				}
		}
	}
	return file;
}

export interface SkillPin {
	name: string;
	version: string;
}

/** One version as the service holds it: its `SKILL.md`, and whether the folder holds more than that. */
interface ReadVersion extends SkillFile {
	bundled: boolean;
}

const SKILL_FILE = /(^|\/)SKILL\.md$/;
/**
 * Versions are immutable, so a read version is kept. The bound is on how
 * many: past it the oldest is forgotten, and read again if it is pinned.
 */
const MAX_READ_VERSIONS = 256;
const read = new Map<string, ReadVersion | null>();

async function folderOf(
	download: Promise<{ readableStreamBody?: NodeJS.ReadableStream }>,
): Promise<Map<string, Uint8Array>> {
	const stream = (await download).readableStreamBody;
	if (!stream) return new Map();
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk as Uint8Array);
	return unzip(Buffer.concat(chunks));
}

/** One version's folder, read once; null for a folder with no `SKILL.md`. */
async function readVersion(pin: SkillPin): Promise<ReadVersion | null> {
	const key = `${pin.name}@${pin.version}`;
	if (read.has(key)) return read.get(key) ?? null;
	const files = await folderOf(
		projectClient().beta.skills.downloadVersion(pin.name, pin.version),
	);
	const paths = [...files.keys()].filter((path) => !path.endsWith("/"));
	const skillPath = paths.find((path) => SKILL_FILE.test(path));
	const version = skillPath
		? {
				...readSkillFile(
					new TextDecoder().decode(files.get(skillPath) as Uint8Array),
				),
				bundled: paths.length > 1,
			}
		: null;
	if (read.size >= MAX_READ_VERSIONS) {
		const oldest = read.keys().next().value;
		if (oldest !== undefined) read.delete(oldest);
	}
	read.set(key, version);
	return version;
}

/**
 * The words of one pinned skill version, as the service holds them: what a
 * prompt agent's version that pins it loads, read for a channel that cannot
 * pin one (the voice agent, `voice-tools.ts`). Null for a folder with no
 * `SKILL.md`.
 */
export async function readSkillVersion(pin: SkillPin): Promise<string | null> {
	return (await readVersion(pin))?.body ?? null;
}

/** A skill a turn may carry: its pinned default version, the version's description and its gating. */
export interface OfferedSkill extends SkillPin {
	description: string;
	surfaces: readonly string[];
	requiresTools: readonly string[];
	enabled: boolean;
}

/** A skill in the project, as the `skills` CLI lists it. */
export interface ManagedSkill extends SkillPin {
	description: string;
	meta: SkillMeta;
}

/**
 * Every skill in the project with its default version's metadata. A skill
 * whose default version cannot be read, or holds no `SKILL.md`, is left
 * out, and said so: nothing says what it is for or where it fits.
 */
export async function listSkills(): Promise<ManagedSkill[]> {
	const found: ManagedSkill[] = [];
	for await (const skill of projectClient().beta.skills.list({ limit: 100 })) {
		const pin = { name: skill.name, version: skill.default_version };
		let version: ReadVersion | null;
		try {
			version = await readVersion(pin);
		} catch (err) {
			console.warn(
				`[skills] "${pin.name}" v${pin.version} could not be read, and is not offered: ${(err as Error).message}`,
			);
			continue;
		}
		if (!version) {
			console.warn(
				`[skills] "${pin.name}" v${pin.version} holds no SKILL.md, and is not offered`,
			);
			continue;
		}
		found.push({
			...pin,
			description: version.description ?? skill.description,
			meta: skillMeta(version.metadata),
		});
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The catalogue in code, pinned to each skill's default version: what a turn
 * carries while the project's skills cannot be listed. A skill the job has
 * not published yet is left out, and said so.
 */
async function catalogueFallback(
	catalogue: readonly SkillSource[],
): Promise<OfferedSkill[]> {
	const pinned = await Promise.all(
		catalogue.map(async (skill): Promise<OfferedSkill | null> => {
			try {
				const held = await projectClient().beta.skills.get(skill.name);
				return {
					name: skill.name,
					version: held.default_version,
					description: skill.description,
					surfaces: skill.surfaces ?? [],
					requiresTools: skill.requiresTools ?? [],
					enabled: true,
				};
			} catch (err) {
				if (!hasStatus(err, 404)) throw err;
				console.warn(
					`[skills] "${skill.name}" is in the catalogue and not published: the job's skills step publishes it`,
				);
				return null;
			}
		}),
	);
	return pinned.filter((skill): skill is OfferedSkill => skill !== null);
}

const OFFER_TTL_MS = 60_000;
let offer: { skills: Promise<OfferedSkill[]>; at: number } | null = null;

/**
 * The project's skills, memoised a minute per replica, so an operator's new
 * default reaches the next agent versions within it; the code's catalogue
 * when the project cannot be listed.
 */
function offeredSkills(
	catalogue: readonly SkillSource[],
): Promise<OfferedSkill[]> {
	if (offer && Date.now() - offer.at < OFFER_TTL_MS) return offer.skills;
	const skills = listSkills().then(
		(managed) =>
			managed.map(({ name, version, description, meta }) => ({
				name,
				version,
				description,
				surfaces: meta.surfaces,
				requiresTools: meta.requiresTools,
				enabled: meta.enabled,
			})),
		(err: Error) => {
			console.warn(
				`[skills] the project's skills could not be listed, the catalogue in code is offered: ${err.message}`,
			);
			return catalogueFallback(catalogue);
		},
	);
	const held = { skills, at: Date.now() };
	offer = held;
	skills.catch(() => {
		if (offer === held) offer = null;
	});
	return skills;
}

/** The skills a turn of this shape carries, by name; none while the operator switched skills off. */
export async function fittingSkills(
	catalogue: readonly SkillSource[],
	turn: ProductTurn,
	skillsEnabled: boolean,
): Promise<OfferedSkill[]> {
	if (!skillsEnabled) return [];
	return (await offeredSkills(catalogue))
		.filter((skill) => skill.enabled && skillFitsTurn(skill, turn))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Forget what was listed and read, so the next read asks the service. For tests and after a publish. */
export function forgetSkills(): void {
	offer = null;
	read.clear();
}

/** What makes a shipped version this entry's: its words and its gating. */
function skillHash(skill: SkillSource): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify([
				skill.name,
				skill.description,
				skill.instructions,
				skill.surfaces ?? [],
				skill.requiresTools ?? [],
			]),
		)
		.digest("hex")
		.slice(0, 24);
}

/** A new version of `name`, its words and metadata inline; the default when `asDefault`. */
export async function publishSkillVersion(
	name: string,
	content: { description: string; instructions: string; meta: SkillMeta },
	asDefault: boolean,
): Promise<string> {
	const made = await projectClient().beta.skills.create(name, {
		inlineContent: {
			description: content.description,
			instructions: content.instructions,
			metadata: metadataOf(content.meta),
		},
		defaultParam: asDefault,
	});
	forgetSkills();
	return made.version;
}

/** The catalogue entry, published as a shipped version and made the default. */
export function publishShipped(skill: SkillSource): Promise<string> {
	return publishSkillVersion(
		skill.name,
		{
			description: skill.description,
			instructions: skill.instructions,
			meta: {
				surfaces: [...(skill.surfaces ?? [])],
				requiresTools: [...(skill.requiresTools ?? [])],
				enabled: true,
				origin: "shipped",
				hash: skillHash(skill),
			},
		},
		true,
	);
}

/** Make `version` the default of `name`: the next agent versions pin it. */
export async function setDefaultSkillVersion(
	name: string,
	version: string,
): Promise<void> {
	await projectClient().beta.skills.update(name, version);
	forgetSkills();
}

/** The default version of `name`, read; null when the project has no such skill. */
export async function defaultSkillVersion(
	name: string,
): Promise<(ReadVersion & SkillPin) | null> {
	let pin: SkillPin;
	try {
		const skill = await projectClient().beta.skills.get(name);
		pin = { name, version: skill.default_version };
	} catch (err) {
		if (hasStatus(err, 404)) return null;
		throw err;
	}
	const version = await readVersion(pin);
	if (!version) throw new Error(`"${name}" v${pin.version} holds no SKILL.md`);
	return { ...version, ...pin };
}

/** `published`: a new default from the catalogue. `unchanged`: the default is already the catalogue's. `kept`: the default is the operator's. */
export type PublishOutcome = "published" | "unchanged" | "kept";

/**
 * The job's `skills` step, which seeds and never overwrites. Each catalogue
 * entry is published as the new default when the project has no such
 * skill, or when its default is a shipped version made from other words. A
 * default the job did not publish (the operator's, from the portal or the
 * CLI, or any version not marked shipped) is kept, so shipped updates flow
 * only until an operator takes the skill over. A skill the catalogue does
 * not name is never touched.
 */
export async function publishSkills(
	catalogue: readonly SkillSource[],
): Promise<Record<string, PublishOutcome>> {
	const outcomes: Record<string, PublishOutcome> = {};
	for (const skill of catalogue) {
		const current = await defaultSkillVersion(skill.name);
		if (current) {
			const meta = skillMeta(current.metadata);
			if (meta.origin !== "shipped") {
				outcomes[skill.name] = "kept";
				continue;
			}
			if (meta.hash === skillHash(skill)) {
				outcomes[skill.name] = "unchanged";
				continue;
			}
		}
		await publishShipped(skill);
		outcomes[skill.name] = "published";
	}
	forgetSkills();
	return outcomes;
}
