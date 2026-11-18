import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { SkillSource } from "@platform/agent";
import {
	defaultSkillVersion,
	listSkills,
	publishShipped,
	publishSkillVersion,
	readSkillFile,
	type SkillMeta,
	setDefaultSkillVersion,
	skillMeta,
	splitList,
} from "@platform/agent/foundry";
import { product } from "./product";

/**
 * The operator's way to manage the skills in the Foundry project:
 * `bun run skills <command>`, as an identity holding Foundry User on the
 * project — the deploying principal does — with `FOUNDRY_PROJECT_ENDPOINT`
 * set.
 *
 *   list                        each skill's default version, origin, switch and fit
 *   publish <name> <path>       a new version from a SKILL.md, or a folder holding one
 *     [--default] [--surfaces a,b] [--requires-tools x,y] [--disabled]
 *   default <name> <version>    an existing version becomes the default
 *   enable <name> | disable <name>
 *                               a new default version with the switch flipped
 *   reset <name>                the code's default becomes the default again
 *
 * A version made here is the operator's (`origin: custom`), so the deploy's
 * `skills` step leaves the skill alone from then on; `reset` hands it back.
 * Versions are published with their words inline, so a folder with files
 * beside its SKILL.md is uploaded in the portal instead. Every replica
 * offers the change within the minute its listing is memoised.
 */

const USAGE =
	"usage: skills list | skills publish <name> <path> [--default] [--surfaces a,b] [--requires-tools x,y] [--disabled] | skills default <name> <version> | skills enable <name> | skills disable <name> | skills reset <name>";

function describe(meta: SkillMeta): string {
	return [
		meta.origin ?? "unmarked",
		meta.enabled ? "enabled" : "disabled",
		`surfaces ${meta.surfaces.join(",") || "all"}`,
		`tools ${meta.requiresTools.join(",") || "any"}`,
	].join(", ");
}

/** The SKILL.md at `path`, or in the folder `path` names, which may hold nothing else. */
async function skillFileAt(path: string): Promise<string> {
	if (!(await stat(path)).isDirectory()) return Bun.file(path).text();
	const entries = await readdir(path, { recursive: true, withFileTypes: true });
	const files = entries.filter((entry) => entry.isFile());
	if (!files.some((entry) => entry.name === "SKILL.md"))
		throw new Error(`${path} holds no SKILL.md`);
	if (files.length > 1)
		throw new Error(
			`${path} holds files beside its SKILL.md: upload a bundled skill in the portal, with its metadata in the SKILL.md front matter`,
		);
	return Bun.file(join(path, "SKILL.md")).text();
}

async function publish(
	name: string,
	path: string,
	flags: {
		default?: boolean;
		surfaces?: string;
		"requires-tools"?: string;
		disabled?: boolean;
	},
): Promise<string> {
	const file = readSkillFile(await skillFileAt(path));
	if (file.name && file.name !== name)
		throw new Error(`${path} names the skill "${file.name}", not "${name}"`);
	if (!file.description)
		throw new Error(`${path} has no description in its front matter`);
	if (!file.body) throw new Error(`${path} has no instructions`);
	const meta = skillMeta(file.metadata);
	const version = await publishSkillVersion(
		name,
		{
			description: file.description,
			instructions: file.body,
			meta: {
				surfaces:
					flags.surfaces === undefined
						? meta.surfaces
						: splitList(flags.surfaces),
				requiresTools:
					flags["requires-tools"] === undefined
						? meta.requiresTools
						: splitList(flags["requires-tools"]),
				enabled: flags.disabled ? false : meta.enabled,
				origin: "custom",
				hash: null,
			},
		},
		flags.default === true,
	);
	return `"${name}" v${version} published${flags.default ? ", the default" : ""}`;
}

async function setEnabled(name: string, enabled: boolean): Promise<string> {
	const current = await defaultSkillVersion(name);
	if (!current) throw new Error(`the project has no skill "${name}"`);
	const meta = skillMeta(current.metadata);
	const state = enabled ? "enabled" : "disabled";
	if (meta.enabled === enabled)
		return `"${name}" v${current.version} is already ${state}`;
	if (current.bundled)
		throw new Error(
			`"${name}" v${current.version} holds files beside its SKILL.md: set enabled in its front matter and upload it in the portal`,
		);
	const version = await publishSkillVersion(
		name,
		{
			description: current.description ?? "",
			instructions: current.body,
			meta: { ...meta, enabled, origin: "custom", hash: null },
		},
		true,
	);
	return `"${name}" v${version}, ${state}, is the default`;
}

export async function skills(
	args: readonly string[],
	catalogue: readonly SkillSource[] = product.skills ?? [],
): Promise<string> {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		options: {
			default: { type: "boolean" },
			surfaces: { type: "string" },
			"requires-tools": { type: "string" },
			disabled: { type: "boolean" },
		},
	});
	const [command, name, extra, ...rest] = positionals;
	const flagged = Object.keys(values).length > 0;
	if (rest.length || (flagged && command !== "publish")) throw new Error(USAGE);
	if (command === "list" && !name) {
		const found = await listSkills();
		return found.length
			? found
					.map(
						(skill) =>
							`${skill.name} v${skill.version}: ${describe(skill.meta)}`,
					)
					.join("\n")
			: "the project has no skills";
	}
	if (command === "publish" && name && extra)
		return publish(name, extra, values);
	if (command === "default" && name && extra) {
		await setDefaultSkillVersion(name, extra);
		return `"${name}" v${extra} is the default`;
	}
	if ((command === "enable" || command === "disable") && name && !extra)
		return setEnabled(name, command === "enable");
	if (command === "reset" && name && !extra) {
		const shipped = catalogue.find((skill) => skill.name === name);
		if (!shipped)
			throw new Error(
				`the code has no default for "${name}": only a shipped skill is reset`,
			);
		return `"${name}" v${await publishShipped(shipped)}, the code's default, is the default`;
	}
	throw new Error(USAGE);
}

if (import.meta.main) {
	try {
		console.log(await skills(process.argv.slice(2)));
	} catch (err) {
		console.error((err as Error).message);
		process.exitCode = 1;
	}
}
