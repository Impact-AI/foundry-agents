import { parseArgs } from "node:util";
import { closeCosmos } from "@platform/cosmos";
import type { SkillStore, SkillVersion } from "@platform/prompt/store";
import { skills as store } from "./product";

/**
 * The operator's way to manage the skills: `bun run skills <command>`, as
 * an identity holding Cosmos DB Built-in Data Contributor on the app's
 * database — the deploying principal does — with `COSMOS_ENDPOINT` set, as
 * for the persona.
 *
 *   list                              each skill's active version, origin, switch and fit
 *   publish <name> <SKILL.md>         a new version from the file
 *     [--surfaces a,b] [--requires-tools x,y] [--disabled] [--activate]
 *   activate <name> <version>         an earlier version becomes the active one
 *   enable <name> | disable <name>    the active version again, switched
 *   reset <name>                      the product's default becomes the active version
 *
 * Every replica serves the change within the memo's 30 seconds.
 */

const USAGE =
	"usage: skills list | skills publish <name> <SKILL.md> [--surfaces a,b] [--requires-tools x,y] [--disabled] [--activate] | skills activate <name> <version> | skills enable <name> | skills disable <name> | skills reset <name>";

const listOf = (value: string | undefined) =>
	(value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);

function line(skill: SkillVersion): string {
	return `${skill.name} ${skill.label}: ${[
		skill.origin,
		skill.enabled ? "enabled" : "disabled",
		`surfaces ${skill.surfaces.join(",") || "all"}`,
		`tools ${skill.requiresTools.join(",") || "any"}`,
	].join(", ")}`;
}

/**
 * A `SKILL.md`: front matter with `name` and `description`, and the
 * instructions after it. Flat `key: value` lines are all it reads; the
 * gating comes from the flags, not the file.
 */
function readSkillFile(text: string): {
	name?: string;
	description?: string;
	body: string;
} {
	const normalised = text.replace(/\r\n/g, "\n");
	const front = /^---\n([\s\S]*?)\n---(\n|$)/.exec(normalised);
	const fields: Record<string, string> = {};
	for (const entry of (front?.[1] ?? "").split("\n")) {
		const pair = /^([A-Za-z0-9_-]+):(.*)$/.exec(entry);
		if (pair?.[1] && pair[2] !== undefined)
			fields[pair[1]] = pair[2].trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return {
		name: fields.name || undefined,
		description: fields.description || undefined,
		body: (front ? normalised.slice(front[0].length) : normalised).trim(),
	};
}

export async function skillsCli(
	args: readonly string[],
	skills: SkillStore = store,
): Promise<string> {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		options: {
			surfaces: { type: "string" },
			"requires-tools": { type: "string" },
			disabled: { type: "boolean" },
			activate: { type: "boolean" },
		},
	});
	const [command, name, extra, ...rest] = positionals;
	if (rest.length || (Object.keys(values).length && command !== "publish"))
		throw new Error(USAGE);
	if (command === "list" && !name) {
		const found = await skills.list();
		return found.length
			? found.map(line).join("\n")
			: "there are no skills stored: the product's defaults are served";
	}
	if (command === "publish" && name && extra) {
		const file = readSkillFile(await Bun.file(extra).text());
		if (file.name && file.name !== name)
			throw new Error(`${extra} names the skill "${file.name}", not "${name}"`);
		if (!file.description)
			throw new Error(`${extra} has no description in its front matter`);
		const label = await skills.publish(
			name,
			{
				description: file.description,
				instructions: file.body,
				surfaces: listOf(values.surfaces),
				requiresTools: listOf(values["requires-tools"]),
				enabled: values.disabled !== true,
			},
			{ activate: values.activate === true },
		);
		const active = (await skills.list()).find((skill) => skill.name === name);
		return active?.label === label
			? `"${name}" ${label} published, the active version`
			: `"${name}" ${label} published; ${active?.label ?? "none"} is still active`;
	}
	if (command === "activate" && name && extra) {
		if (!(await skills.activate(name, extra)))
			throw new Error(`the skill "${name}" has no version "${extra}"`);
		return `"${name}" ${extra} is the active version`;
	}
	if ((command === "enable" || command === "disable") && name && !extra) {
		const state = command === "enable" ? "enabled" : "disabled";
		const label = await skills.setEnabled(name, command === "enable");
		return label
			? `"${name}" ${label}, ${state}, is the active version`
			: `"${name}" is already ${state}`;
	}
	if (command === "reset" && name && !extra)
		return `"${name}" ${await skills.reset(name)}, the product's default, is the active version`;
	throw new Error(USAGE);
}

if (import.meta.main) {
	try {
		console.log(await skillsCli(process.argv.slice(2)));
	} catch (err) {
		console.error((err as Error).message);
		process.exitCode = 1;
	} finally {
		closeCosmos();
	}
}
