import type { ProductTurn, SkillSource } from "../contract/product";
import { skillFitsTurn } from "../skills/skills";
import { hasStatus, projectClient } from "./client";
import { unzip } from "./zip";

/**
 * Skills on Foundry (preview): the product's catalogue, published by the
 * job as skill versions, and pinned by name and version into each agent
 * version a turn's shape fits.
 *
 * Which skills fit is decided here from the catalogue, by surface and by
 * the tools they need: the service's skill objects carry no metadata to
 * gate on (2.10.0 reads back a name, a description and versions). The
 * version pinned is the skill's default, read from the service, so an
 * operator who makes a new default version in the portal changes the next
 * agent version — the definition's hash covers it.
 */

/** The catalogue's entries a turn of this shape carries; none while the operator switched skills off. */
export function fittingSkills(
	catalogue: readonly SkillSource[],
	turn: ProductTurn,
	skillsEnabled: boolean,
): SkillSource[] {
	if (!skillsEnabled) return [];
	return catalogue
		.filter((skill) => skillFitsTurn(skill, turn))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillPin {
	name: string;
	version: string;
}

const PIN_TTL_MS = 60_000;
const pins = new Map<string, { pin: SkillPin | null; at: number }>();

/**
 * Each skill's default version, memoised a minute per replica: a skill the
 * job has not published yet is left out, and said so, rather than failing
 * the turn.
 */
export async function pinnedSkills(
	skills: readonly SkillSource[],
): Promise<SkillPin[]> {
	const pinned = await Promise.all(
		skills.map(async ({ name }) => {
			const held = pins.get(name);
			if (held && Date.now() - held.at < PIN_TTL_MS) return held.pin;
			let pin: SkillPin | null = null;
			try {
				const skill = await projectClient().beta.skills.get(name);
				pin = { name, version: skill.default_version };
			} catch (err) {
				if (!hasStatus(err, 404)) throw err;
				console.warn(
					`[skills] "${name}" is in the catalogue and not published: the job's skills step publishes it`,
				);
			}
			pins.set(name, { pin, at: Date.now() });
			return pin;
		}),
	);
	return pinned.filter((pin): pin is SkillPin => pin !== null);
}

/** Forget the pins, so the next read asks the service. For tests and after a publish. */
function forgetSkillPins(): void {
	pins.clear();
	read.clear();
}

const SKILL_FILE = /(^|\/)SKILL\.md$/;
/** Versions are immutable, so a read version is kept; the catalogue bounds how many there are. */
const MAX_READ_VERSIONS = 64;
const read = new Map<string, string>();

/** A skill folder's `SKILL.md`, its front matter (name, description, metadata) left out. */
function skillBody(files: Map<string, Uint8Array>): string | null {
	for (const [path, bytes] of files)
		if (SKILL_FILE.test(path)) {
			const text = new TextDecoder().decode(bytes);
			return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
		}
	return null;
}

async function folderOf(
	download: Promise<{ readableStreamBody?: NodeJS.ReadableStream }>,
): Promise<Map<string, Uint8Array>> {
	const stream = (await download).readableStreamBody;
	if (!stream) return new Map();
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk as Uint8Array);
	return unzip(Buffer.concat(chunks));
}

/**
 * The words of one pinned skill version, as the service holds them: what a
 * prompt agent's version that pins it loads, read for a channel that cannot
 * pin one (the voice agent, `voice-tools.ts`). Kept per version, since a
 * version never changes; null for a folder with no `SKILL.md`.
 */
export async function readSkillVersion(pin: SkillPin): Promise<string | null> {
	const key = `${pin.name}@${pin.version}`;
	const held = read.get(key);
	if (held !== undefined) return held;
	const body = skillBody(
		await folderOf(
			projectClient().beta.skills.downloadVersion(pin.name, pin.version),
		),
	);
	if (body === null) return null;
	if (read.size >= MAX_READ_VERSIONS) read.clear();
	read.set(key, body);
	return body;
}

/** What makes a published version this entry's: its words. */
function skillHash(skill: SkillSource): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify([skill.name, skill.description, skill.instructions]))
		.digest("hex")
		.slice(0, 24);
}

/** Whether the version the service serves as default carries `hash`, by reading its folder. */
async function defaultCarries(name: string, hash: string): Promise<boolean> {
	const files = await folderOf(projectClient().beta.skills.download(name));
	const decoder = new TextDecoder();
	return [...files.values()].some((file) =>
		decoder.decode(file).includes(hash),
	);
}

export type PublishOutcome = "published" | "unchanged";

/**
 * The job's `skills` step: each catalogue entry published as a new default
 * version when its words changed since the default was made, and left alone
 * otherwise. The hash rides in the version's metadata, which the service
 * writes into the skill's folder; a default that does not carry it — an
 * operator's portal edit, or a service that drops metadata — is replaced,
 * so a deploy never leaves the catalogue's words unpublished. A skill an
 * operator made that the catalogue does not name is never touched.
 */
export async function publishSkills(
	catalogue: readonly SkillSource[],
): Promise<Record<string, PublishOutcome>> {
	const skills = projectClient().beta.skills;
	const outcomes: Record<string, PublishOutcome> = {};
	for (const skill of catalogue) {
		const hash = skillHash(skill);
		let exists = true;
		try {
			await skills.get(skill.name);
		} catch (err) {
			if (!hasStatus(err, 404)) throw err;
			exists = false;
		}
		if (exists && (await defaultCarries(skill.name, hash))) {
			outcomes[skill.name] = "unchanged";
			continue;
		}
		await skills.create(skill.name, {
			inlineContent: {
				description: skill.description,
				instructions: skill.instructions,
				metadata: { "content-hash": hash },
			},
			defaultParam: true,
		});
		outcomes[skill.name] = "published";
	}
	forgetSkillPins();
	return outcomes;
}
