import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * No dependency may float.
 *
 * `bun install --frozen-lockfile` — what CI and every Dockerfile run — checks
 * that the lockfile still satisfies the manifests. A dist-tag cannot satisfy it:
 * `"latest"` means "resolve against the registry", so the day a dependency
 * publishes, the frozen resolve disagrees with what is recorded and the install
 * refuses before anything is built. Nothing in the repository changed; someone
 * else's release day did, and the failure lands on whichever push comes first.
 * Refreshing the lockfile to get past it takes whatever that release changed
 * with it: an unpinned dependency is an upgrade nobody scheduled.
 *
 * A range is fine — `^4.13.1` is satisfied by whatever the lockfile holds, so a
 * frozen install stays happy and the upgrade happens when someone runs a bare
 * `bun install` and commits the result. Only tags and wildcards are refused,
 * wherever a manifest writes a version: a dependency section, an override, a
 * resolution, or the version an `npm:` alias names.
 */

const ROOT = join(import.meta.dir, "..");

/** What a version may start with: a digit, or a range operator. */
const SEMVER_ISH = /^[\d^~><=]/;

/** A wildcard in place of a number: `*`, `1.x`, `1.*`. */
const WILDCARD = /(?:^|[.\s|])[xX*](?:$|[.\s|])/;

/**
 * Protocols that name something other than a registry version, and so are not
 * the registry-resolution problem above: workspace links, tarballs, git
 * checkouts, local paths, and `catalog:`, which names a version the
 * workspace's catalog writes once and this test reads there. An `npm:` alias is not one of them: it names a
 * registry version, which is read like any other.
 */
const PROTOCOLS =
	/^(workspace|file|link|git|git\+[a-z]+|github|https?|patch|catalog):/;

const SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
	"overrides",
	"resolutions",
] as const;

/** An override may nest: a package's own overrides under its name. */
type Versions = { [name: string]: string | Versions };
type Manifest = Partial<Record<(typeof SECTIONS)[number], Versions>> &
	Catalogs & { workspaces?: string[] | Catalogs };
/** A workspace's catalogs: one unnamed, or several by name, at the root or under `workspaces`. */
interface Catalogs {
	catalog?: Versions;
	catalogs?: Versions;
}

/** Whether a specifier re-resolves against the registry on every install. */
function floats(specifier: string): boolean {
	if (PROTOCOLS.test(specifier)) return false;
	// `npm:name@version`, the name possibly scoped; no version at all is `latest`.
	const alias = /^npm:(?:@[^@/]+\/)?[^@]+(?:@(.*))?$/.exec(specifier);
	const version = alias ? (alias[1] ?? "") : specifier;
	return !SEMVER_ISH.test(version) || WILDCARD.test(version);
}

/** Every floating specifier of a manifest, as `section.name: "specifier"`. */
function floating(manifest: Manifest): string[] {
	const found: string[] = [];
	const read = (versions: Versions, at: string) => {
		for (const [name, version] of Object.entries(versions)) {
			if (typeof version === "string") {
				if (floats(version)) found.push(`${at}.${name}: "${version}"`);
			} else read(version, `${at}.${name}`);
		}
	};
	for (const section of SECTIONS) read(manifest[section] ?? {}, section);
	const workspaces = Array.isArray(manifest.workspaces)
		? undefined
		: manifest.workspaces;
	for (const [at, holder] of [
		["", manifest],
		["workspaces.", workspaces ?? {}],
	] as const) {
		read(holder.catalog ?? {}, `${at}catalog`);
		read(holder.catalogs ?? {}, `${at}catalogs`);
	}
	return found;
}

/**
 * Every manifest in the workspace: the root and one level under apps/ and
 * platform/. One level on purpose — a deeper glob would sweep in build output
 * (a Next app's `.next/standalone` carries a copy of the manifest it was built
 * from) and fail on a file nobody edits.
 */
async function manifests(): Promise<{ path: string; manifest: Manifest }[]> {
	const paths = ["package.json"];
	for await (const found of new Bun.Glob("{apps,platform}/*/package.json").scan(
		ROOT,
	)) {
		paths.push(found);
	}
	paths.sort();
	return Promise.all(
		paths.map(async (path) => ({
			path,
			manifest: (await Bun.file(join(ROOT, path)).json()) as Manifest,
		})),
	);
}

test("no dependency, override or resolution is pinned to a dist-tag or a wildcard", async () => {
	const found: string[] = [];
	for (const { path, manifest } of await manifests())
		for (const hit of floating(manifest)) found.push(`${path} → ${hit}`);

	// The message is the fix: whoever trips this is reading it in a CI log, and
	// what they need is the version to write down.
	expect(
		found,
		found.length
			? `These specifiers re-resolve on every install, so \`bun install --frozen-lockfile\` ` +
					`fails the day the package publishes — see the note at the top of this file. ` +
					`Replace each with the version the lockfile already holds ` +
					`(\`bun pm ls\`), exactly or with a caret:\n  ${found.join("\n  ")}`
			: undefined,
	).toEqual([]);
});

test("a tag or a wildcard floats wherever a manifest writes it; a range, a link and a pinned alias do not", () => {
	for (const specifier of [
		"latest",
		"next",
		"*",
		"1.x",
		"1.*",
		"npm:other@latest",
		"npm:@scope/other@next",
		"npm:other",
		"",
	])
		expect(floats(specifier), specifier).toBe(true);
	for (const specifier of [
		"1.2.3",
		"^1.2.3",
		"~1.2",
		">=1.2.3 <2",
		"workspace:*",
		"npm:other@^1.2.3",
		"npm:@scope/other@1.2.3",
		"github:owner/repo#0123abc",
		"git+https://example.com/owner/repo.git#0123abc",
		"catalog:",
		"catalog:testing",
	])
		expect(floats(specifier), specifier).toBe(false);
	expect(
		floating({
			dependencies: { a: "^1.0.0", b: "latest" },
			overrides: { c: "*", d: { e: "next", f: "1.0.0" } },
			resolutions: { g: "npm:h@latest" },
			catalog: { i: "latest", j: "^1.0.0" },
			workspaces: { catalogs: { testing: { k: "next" } } },
		}),
	).toEqual([
		'dependencies.b: "latest"',
		'overrides.c: "*"',
		'overrides.d.e: "next"',
		'resolutions.g: "npm:h@latest"',
		'catalog.i: "latest"',
		'workspaces.catalogs.testing.k: "next"',
	]);
});

test("the workspace scan finds every manifest it is meant to", async () => {
	// A guard that quietly stopped matching would pass forever. The root plus
	// every app and package is the set; a new top-level workspace is one more
	// tree for the glob above.
	const found = (await manifests()).map((m) => m.path);
	expect(found).toContain("package.json");
	expect(found).toContain("apps/backend/package.json");
	expect(found).toContain("platform/config/package.json");
	expect(found.length).toBeGreaterThanOrEqual(10);
	// Build output is not a manifest anyone edits.
	expect(found.some((p) => p.includes(".next"))).toBe(false);
});
