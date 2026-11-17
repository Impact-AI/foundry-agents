/**
 * This repository is a template: what a reader is told — the documentation,
 * every README, CLAUDE.md, the comments in the code and the names of its
 * tests — says what is true and why, never what happened on one deployment.
 * Two shapes of the second kind are caught here with a ceiling of zero: a
 * calendar date, which dates a reading, and a pointer into an engineering
 * record nobody using the template has. A limit known only from how a
 * service behaves is stated as such, as a general note; a version is not a
 * date and is written as one (`2026-07-15`, `2026-08-01-preview`).
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The trees whose comments and test names a template user reads. */
const CODE_TREES = [
	"apps",
	"platform",
	"infra",
	"hooks",
	"scripts",
	".github",
	".githooks",
	"site",
];

/** The code and configuration at the root, beside the trees. */
const ROOT_CODE = [
	"pipeline.test.ts",
	"build-context.test.ts",
	"azure.yaml",
	"bunfig.toml",
	".fallowrc.jsonc",
	".dockerignore",
	".devcontainer/devcontainer.json",
];

/** This file names the shapes it looks for. */
const SELF = new Set(["scripts/template-prose.test.ts"]);

const SKIP = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
const CODE = /\.(ts|tsx|mts|js|mjs|css|bicep|sh|ps1|yml|yaml|toml|jsonc)$/;
/** A file with no extension: a Dockerfile, a git hook, an ignore file. Its comments start with `#`. */
const BARE = /(?:^|\/)\.?[A-Za-z-]+$/;
/** An environment file, the example beside each app among them. Its comments start with `#` too. */
const ENV = /(?:^|\/)\.env(?:\.[a-z]+)?$/;
/** What opens a test: bun's own three, and the helper that runs a scenario through both twins. */
const TEST = "(?:test|it|describe|eachTwin)";

function walk(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name) || name.startsWith(".next")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else out.push(path);
	}
	return out;
}

/** The prose of a source file: its comments and its test names, line by line. */
export function commentary(source: string, file: string): string[] {
	const hash =
		/\.(sh|ps1|yml|yaml|toml)$/.test(file) || BARE.test(file) || ENV.test(file);
	// PowerShell's block comment, `<#` to `#>`, beside its `#` lines.
	const powershell = file.endsWith(".ps1");
	const lines: string[] = [];
	let block = false;
	// A test's name on the line after its call opens: `test.skipIf(…)(` then the name.
	let opened = false;
	for (const line of source.split("\n")) {
		const parts: string[] = [];
		if (opened) {
			const alone = /^\s*(["'`])((?:(?!\1).)*)\1,?\s*$/.exec(line);
			if (alone) parts.push(alone[2] ?? "");
		}
		opened = !hash && new RegExp(`\\b${TEST}\\b.*\\($`).test(line);
		if (block) {
			const end = line.indexOf(powershell ? "#>" : "*/");
			parts.push(end < 0 ? line : line.slice(0, end));
			if (end >= 0) block = false;
		} else if (powershell && line.includes("<#")) {
			const rest = line.slice(line.indexOf("<#") + 2);
			const end = rest.indexOf("#>");
			parts.push(end < 0 ? rest : rest.slice(0, end));
			if (end < 0) block = true;
		} else if (hash) {
			const m = /(?:^|\s)#(?![!{])(.*)$/.exec(line);
			if (m) parts.push(m[1] ?? "");
		} else {
			const open = line.indexOf("/*");
			const slash = /(?:^|[\s;,({])\/\/(.*)$/.exec(line);
			if (open >= 0 && (!slash || open < (slash.index ?? 0))) {
				const rest = line.slice(open + 2);
				const end = rest.indexOf("*/");
				parts.push(end < 0 ? rest : rest.slice(0, end));
				if (end < 0) block = true;
			} else if (slash) parts.push(slash[1] ?? "");
			// The name is the first argument, of the call itself or of what a
			// modifier returns: `test.each(rows)("name"`, `test.skipIf(x)("name"`.
			const name = new RegExp(
				`\\b${TEST}(?:\\.\\w+)*\\((?:[^"'\`]*\\)\\()?\\s*(["'\`])((?:(?!\\1).)*)\\1`,
			).exec(line);
			if (name) parts.push(name[2] ?? "");
		}
		lines.push(parts.join(" "));
	}
	return lines;
}

/**
 * A calendar date that is not a version: not followed by `-preview`, not an
 * `api-version`, a resource's `@` version or a JSON `"version"` field, not
 * inside a URL, and not a version-like token on its own in backticks. A date
 * written out, or with slashes, is never a version.
 */
const DATE = /\b20\d\d-\d\d-\d\d\b/g;
const MONTH =
	"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const WRITTEN_DATE = new RegExp(
	[
		`\\b\\d{1,2} ${MONTH},? 20\\d\\d\\b`,
		`\\b${MONTH} \\d{1,2},? 20\\d\\d\\b`,
		"\\b20\\d\\d[/.]\\d\\d[/.]\\d\\d\\b",
		// Day and month in either order, with dots, slashes or hyphens, and the year last.
		"\\b\\d{1,2}[./-]\\d{1,2}[./-]20\\d\\d\\b",
		// A month and its year alone say when as well.
		`\\b${MONTH} 20\\d\\d\\b`,
	].join("|"),
	"g",
);

export function datedReadings(line: string): string[] {
	const text = line.replace(/https?:\/\/[^\s)>\]]+/g, " ");
	const found: string[] = [];
	for (const m of text.matchAll(DATE)) {
		const at = m.index ?? 0;
		const before = text.slice(Math.max(0, at - 16), at);
		const after = text.slice(at + m[0].length);
		if (after.startsWith("-preview")) continue;
		// `@` is a version's only after the resource it versions, never after a space.
		if (
			/(?:api-?version[=: ]*["'`]?|[\w)\]]@|version\s+|"version":\s*")$/i.test(
				before,
			)
		)
			continue;
		if (before.endsWith("`") && /^(?:-preview)?`/.test(after)) continue;
		found.push(m[0]);
	}
	for (const m of text.matchAll(WRITTEN_DATE)) found.push(m[0]);
	return found;
}

/**
 * A pointer into an engineering record this repository does not carry: a
 * record folder or index, a numbered report by file name, or a corrections
 * id (`D12`, `H11`) on a line that speaks of corrections, decisions or
 * findings.
 */
const RECORD_PATH =
	/reference-review\/|REFERENCE-REVIEW|\b13-first-run\b|\b[0-2]\d-[a-z][a-z0-9-]*\.md\b/g;
const CORRECTION_ID = /\b[DH]\d{1,2}\b/g;
const CORRECTION_CONTEXT = /correction|decision|finding|record|fixed/i;

export function recordPointers(line: string): string[] {
	const found = [...line.matchAll(RECORD_PATH)].map((m) => m[0]);
	if (CORRECTION_CONTEXT.test(line))
		found.push(...[...line.matchAll(CORRECTION_ID)].map((m) => m[0]));
	return found;
}

/**
 * The prose of a Markdown page, line by line, with what is not prose blanked:
 * fenced code blocks, HTML comments, code spans, link targets and bare URLs,
 * and identifiers — a token with a dot, slash or underscore inside it
 * (`catalogue-parity.test.ts`), or a quoted word with no space in it.
 */
export function markdownProse(markdown: string): string[] {
	const blank = (m: string) => m.replace(/[^\n]/g, "");
	return markdown
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1/gm, blank)
		.split("\n")
		.map((line) =>
			line
				.replace(/`[^`]*`/g, " ")
				.replace(/\]\([^)]*\)/g, "]")
				.replace(/https?:\/\/[^\s)>\]]+/g, " ")
				.replace(/\S*\w[./_]\w\S*/g, " ")
				.replace(/"[^"\s]+"/g, " "),
		);
}

/**
 * The pages and READMEs are written in US English. A British spelling of a
 * word they use is caught in their prose; a code identifier, a file name or a
 * quoted string keeps the spelling the code gives it.
 */
const UK_SPELLING = new RegExp(
	[
		"behaviour(?:s|al)?",
		"colour(?:s|ed|ing|ful)?",
		"catalogue[sd]?",
		"licence[sd]?|licencing",
		"honour(?:s|ed|ing|able)?|favour(?:s|ed|ing|ite|able)?",
		"centre[sd]?",
		"defence",
		"judgement",
		"enrol(?:s|ment)?|fulfil(?:s|ment)?",
		"(?:cancel|label|model|travel|signal|dial|tunnel)l(?:ed|ing)",
		// `analyses` is also the plural of `analysis`.
		"analys(?:e|ed|ing)",
		// -ise and -isation: the stems the pages use, never a word whose s is its own (`synthesis`, `emphasis`).
		`(?:organ|recogn|summar|memo|synthes|quant|initial|serial|deserial|author|normal|optim|priorit|custom|personal|minim|maxim|util|final|standard|categor|character|special|apolog|real|emphas|stabil|visual|local|capital|parameter|sanit|token|vector|anonym|pseudonym)is(?:e|es|ed|ing|ation|ations|er|ers)`,
	]
		.map((word) => `(?:${word})`)
		.join("|"),
	"gi",
);

export function ukSpellings(line: string): string[] {
	return [
		...line.matchAll(new RegExp(`\\b(?:${UK_SPELLING.source})\\b`, "gi")),
	].map((m) => m[0]);
}

/**
 * Words the pages leave behind: a review marker, the platform's former name,
 * and a reading taken on one machine.
 */
const RETIRED = /\[confirm\]|\bAzure AI Foundry\b|\bthis machine\b/gi;

export function retiredWords(line: string): string[] {
	return [...line.matchAll(RETIRED)].map((m) => m[0]);
}

/** Hits that are legitimate, as `path:match`, each with why. */
const ALLOWED = new Map<string, string>([]);

function inScope(): { file: string; lines: string[] }[] {
	const out: { file: string; lines: string[] }[] = [];
	const add = (path: string, lines: string[]) =>
		out.push({ file: relative(ROOT, path), lines });
	for (const name of readdirSync(ROOT).filter((name) => name.endsWith(".md")))
		add(join(ROOT, name), readFileSync(join(ROOT, name), "utf8").split("\n"));
	for (const name of ROOT_CODE)
		add(
			join(ROOT, name),
			commentary(readFileSync(join(ROOT, name), "utf8"), name),
		);
	for (const path of walk(join(ROOT, "docs"))) {
		const file = relative(ROOT, path);
		if (file.endsWith(".md")) add(path, readFileSync(path, "utf8").split("\n"));
		else if (CODE.test(file))
			add(path, commentary(readFileSync(path, "utf8"), file));
	}
	for (const tree of CODE_TREES)
		for (const path of walk(join(ROOT, tree))) {
			const file = relative(ROOT, path);
			if (SELF.has(file)) continue;
			// The documents a library is made of are the product's content, not the template's prose.
			if (file.endsWith(".md")) {
				if (!/\/(sample|testing)\//.test(file))
					add(path, readFileSync(path, "utf8").split("\n"));
			} else if (CODE.test(file) || BARE.test(file) || ENV.test(file))
				add(path, commentary(readFileSync(path, "utf8"), file));
		}
	return out;
}

const scope = inScope();

/** The Markdown pages of the scope, their prose alone. */
const pages = scope
	.filter(({ file }) => file.endsWith(".md"))
	.map(({ file, lines }) => ({
		file,
		lines: markdownProse(lines.join("\n")),
	}));

function offenders(
	read: (line: string) => string[],
	within: { file: string; lines: string[] }[] = scope,
): string[] {
	const found: string[] = [];
	for (const { file, lines } of within)
		lines.forEach((line, i) => {
			for (const hit of read(line))
				if (!ALLOWED.has(`${file}:${hit}`))
					found.push(`${file}:${i + 1}: ${hit}`);
		});
	return found;
}

test("the date reader finds a dated reading and leaves a version alone", () => {
	for (const prose of [
		"measured on demo (2026-10-28)",
		"measured @2026-10-28 on demo",
		"read on 28 October 2026",
		"read on October 28, 2026",
		"as of 2026/10/28",
		"read on 28 Oct 2026",
		"read on Oct 28, 2026",
		"read on Sept. 3, 2026",
		"as of 28.10.2026",
		"as of 2026.10.28",
		"as of 28-10-2026",
		"prices as of Oct 2026",
		"read in October 2026",
		"as of 10/28/2026",
		"Today (2026-10-23) the tool",
		"read 2026-10-29, after the deploy",
		"// As the service sent it on 2026-10-27.",
	])
		expect(datedReadings(prose)).not.toEqual([]);
	for (const prose of [
		"answers only on `2026-08-01-preview`",
		"the 2026-05-01-preview API",
		"?api-version=2026-11-01",
		"API `2025-05-01`",
		"`gpt-5.6-luna` `2026-07-09`",
		"Microsoft.Search/searchServices@2025-05-01",
		"[reference](https://learn.microsoft.com/x/voice-live-api-reference-2026-07-15)",
		"the Voice Live API reference, version 2026-07-15",
		'"version": "2026-07-07",',
	])
		expect(datedReadings(prose)).toEqual([]);
});

test("the record reader finds a pointer and leaves ordinary prose alone", () => {
	for (const prose of [
		"see `docs/reference-review/18-voice-live-design.md` §0",
		"the readings in 13-first-run",
		"`17-phase4-checklist.md` row 4.3",
		"corrections table, D35",
		"recorded as H11 in the decisions",
	])
		expect(recordPointers(prose)).not.toEqual([]);
	for (const prose of [
		"decision 3 keeps the history",
		"a chart of D3 and H2 by quarter",
		"[architecture.md](architecture.md#voice)",
		"the `index` step",
		"Standard C1 Redis",
	])
		expect(recordPointers(prose)).toEqual([]);
});

test("the comment reader reads comments and test names, not code", () => {
	const source = [
		'const at = "2026-10-20"; // read on 2026-10-21',
		"/** One block,",
		" * dated 2026-10-22. */",
		'test("named 2026-10-23", () => {});',
		'const url = "https://example.com/x";',
	].join("\n");
	const lines = commentary(source, "a.ts");
	expect(lines.flatMap(datedReadings)).toEqual([
		"2026-10-21",
		"2026-10-22",
		"2026-10-23",
	]);
	expect(
		commentary("x=1 # on 2026-10-24\necho '#{ok}'", "a.sh").flatMap(
			datedReadings,
		),
	).toEqual(["2026-10-24"]);
	// A file with no extension is a script: its comments start with `#`.
	expect(
		commentary("# red on 2026-10-25\nexit 0", ".githooks/pre-commit").flatMap(
			datedReadings,
		),
	).toEqual(["2026-10-25"]);
	// A name behind a modifier, on the call's line or the one after it.
	expect(
		commentary(
			[
				'test.skipIf(!NODE)("named 2026-10-26", () => {});',
				'test.skipIf(Bun.which("dash") === null)(',
				'\t"named 2026-10-27",',
				"\t() => {},",
				");",
			].join("\n"),
			"a.test.ts",
		).flatMap(datedReadings),
	).toEqual(["2026-10-26", "2026-10-27"]);
	// A scenario run through both twins is named by the helper's first argument.
	expect(
		commentary(
			[
				'eachTwin("named 2026-10-28", (shell) => {});',
				"eachTwin(",
				'\t"named 2026-10-29",',
				"\t(shell) => {},",
				");",
			].join("\n"),
			"a.test.ts",
		).flatMap(datedReadings),
	).toEqual(["2026-10-28", "2026-10-29"]);
	// An environment file's comments, and PowerShell's block comment.
	expect(
		commentary("KEY=1 # set on 2026-10-30\n", "apps/x/.env.example").flatMap(
			datedReadings,
		),
	).toEqual(["2026-10-30"]);
	expect(
		commentary(
			"<# read on 2026-10-31\nand 2026-11-01 #>\n$x = '2026-11-02' # on 2026-11-03",
			"a.ps1",
		).flatMap(datedReadings),
	).toEqual(["2026-10-31", "2026-11-01", "2026-11-03"]);
});

test("the template's prose carries no dated reading", () => {
	expect(offenders(datedReadings)).toEqual([]);
});

test("the template's prose points into no engineering record", () => {
	expect(offenders(recordPointers)).toEqual([]);
});

test("the gate reads every tree a template user reads", () => {
	const seen = new Set(scope.map((s) => s.file.split("/")[0]));
	for (const tree of [
		"README.md",
		"CLAUDE.md",
		"CONTRIBUTING.md",
		"SECURITY.md",
		"SUPPORT.md",
		"docs",
		...ROOT_CODE.map((file) => file.split("/")[0] as string),
		...CODE_TREES,
	])
		expect(seen.has(tree), tree).toBe(true);
	expect(scope.some((s) => s.file === ".githooks/pre-commit")).toBe(true);
	expect(scope.some((s) => s.file.endsWith("/.env.example"))).toBe(true);
});

test("the spelling reader finds a British spelling in prose and leaves code alone", () => {
	for (const prose of [
		"the behaviour of the service",
		"a colour per scheme",
		"the message catalogues",
		"the organisation's account",
		"under an MIT licence",
		"it summarises the thread",
		"the voice is synthesised",
		"a cancelled turn",
		"memoised for 30 s",
		"analysed once",
	])
		expect(ukSpellings(prose), prose).not.toEqual([]);
	for (const prose of [
		"the behavior of the service",
		"behavioral, colors, catalogs, organizations, licensed",
		"a speech synthesis voice, with emphasis",
		"the analyses it ran, the exercise, a promise, enterprise",
		"honored, canceled, modeling, labeled",
	])
		expect(ukSpellings(prose), prose).toEqual([]);
	const page = markdownProse(
		[
			"Code: `behaviour(turn)` and [the parity test](../catalogue-parity.test.ts).",
			'The file catalogue-parity.test.ts, the key "colour".',
			"```ts",
			"const colour = 1;",
			"```",
			"<!-- a colour -->",
			"See https://example.com/colour-guide for more.",
		].join("\n"),
	);
	expect(page.flatMap(ukSpellings)).toEqual([]);
	expect(page).toHaveLength(7);
});

test("the template's pages are written in US English", () => {
	expect(offenders(ukSpellings, pages)).toEqual([]);
});

test("the template's pages carry no review marker, former name or one machine's reading", () => {
	for (const prose of [
		"a cell [confirm] to check",
		"the Azure AI Foundry project",
		"measured on this machine",
	])
		expect(retiredWords(prose)).not.toEqual([]);
	expect(
		retiredWords("the Microsoft Foundry project, on your machine"),
	).toEqual([]);
	expect(offenders(retiredWords, pages)).toEqual([]);
});

/**
 * The overview pages are read by whoever decides on a project: a systems
 * integrator, a decision-maker, a delivery manager. They speak in plain words,
 * prices and trade-offs, and link to the page that holds the detail. A
 * command, an environment variable, a settings path or a file path belongs on
 * a build, deploy or reference page, so these pages carry no fenced code
 * block and no code span that reads as one. Azure service and model names are
 * plain words here, and the detectors leave them alone.
 */
const OVERVIEW_PAGES = [
	"site/index.md",
	"docs/is-it-a-fit.md",
	"docs/cost.md",
	"docs/impact-ai.md",
];

/**
 * A code span an overview page may carry although a detector reads it as
 * detail, by its exact text, each with why. Empty while every model and
 * deployment name the pages give passes the detectors on its own.
 */
const OVERVIEW_CODE_ALLOWED = new Map<string, string>([]);

/** An environment variable as the template names them: capitals joined by underscores. */
const ENV_VAR = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** A variable assignment written bare in prose. */
const ASSIGNMENT = /\b[A-Z][A-Z0-9_]*=\S/g;

/** Why a code span is detail, or null when it is a plain name. */
function codeDetail(code: string): string | null {
	const text = code.trim();
	if (/^(?:az|azd|bun|bunx)\s/.test(text) || text.includes("./scripts/"))
		return "a command";
	if (
		new RegExp(ENV_VAR.source).test(text) ||
		/^[A-Z][A-Z0-9_]+(?:=.*)?$/.test(text)
	)
		return "an environment variable";
	if (text.includes("/")) return "a path";
	if (/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+$/.test(text))
		return "a settings path or a file name";
	return null;
}

/**
 * The detail an overview page carries, as `line: what`: each fenced code
 * block once, at its opening line; each code span a detector reads as a
 * command, an environment variable, a path or a settings path; and an
 * environment variable or an assignment written bare in the prose. Link
 * targets and URLs are not prose.
 */
export function overviewDetail(
	markdown: string,
	allowed: ReadonlyMap<string, string> = OVERVIEW_CODE_ALLOWED,
): string[] {
	const found: string[] = [];
	let fence: string | null = null;
	markdown.split("\n").forEach((line, i) => {
		const at = i + 1;
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence !== null) {
			if (marker?.startsWith(fence)) fence = null;
			return;
		}
		if (marker) {
			fence = marker;
			found.push(`${at}: a fenced code block`);
			return;
		}
		const text = line
			.replace(/\]\([^)]*\)/g, "]")
			.replace(/https?:\/\/[^\s)>\]]+/g, " ");
		for (const m of text.matchAll(/`([^`]+)`/g)) {
			const code = m[1] ?? "";
			if (allowed.has(code)) continue;
			const what = codeDetail(code);
			if (what) found.push(`${at}: \`${code}\` (${what})`);
		}
		const prose = text.replace(/`[^`]*`/g, " ");
		for (const m of prose.matchAll(ENV_VAR))
			found.push(`${at}: ${m[0]} (an environment variable)`);
		for (const m of prose.matchAll(ASSIGNMENT))
			found.push(`${at}: ${m[0]} (an assignment)`);
	});
	return found;
}

test("the overview reader finds a command, a variable and a path, and leaves plain names alone", () => {
	for (const page of [
		"```sh\nazd up\n```",
		"~~~\nanything\n~~~",
		"run `azd up` first",
		"sign in with `az login`",
		"`bun scripts/verify-deployment.ts --voice`",
		"load it with `./scripts/ingest.sh ~/my-docs`",
		"set `AZURE_SEARCH_LOCATION` first",
		"with `HARDENED` set",
		"`HARDENED=true` before the first deploy",
		"open FRONTEND_URL in a browser",
		"set HARDENED=true before the first deploy",
		"turn on `access.enforceAccessControl`",
		"lower `limits.chat.perDay`",
		"readers in `access.json`",
		"the code in `apps/backend/`",
	])
		expect(overviewDetail(page), page).not.toEqual([]);
	for (const page of [
		"`gpt-5.6-luna` and `gpt-realtime-2.1`, `text-embedding-3-large`",
		"two responses on `chat` and one on `small`",
		"[load a library](documents.md#load-a-library)",
		"[pricing](https://azure.microsoft.com/pricing/details/search_units/)",
		"MIT licensed, SHA-256, USD, Bun 1.4, Hono 4 on Bun",
		'<ol class="steps">',
	])
		expect(overviewDetail(page), page).toEqual([]);
	// A fence is reported once, and nothing inside it is read again.
	expect(overviewDetail("```sh\nazd env set FOO_BAR 1\n```\nplain")).toEqual([
		"1: a fenced code block",
	]);
	// An allowed span passes by its exact text, and only that text.
	const allowed = new Map([["FOO_BAR", "a reason"]]);
	expect(overviewDetail("`FOO_BAR`", allowed)).toEqual([]);
	expect(overviewDetail("`FOO_BAZ`", allowed)).toEqual([
		"1: `FOO_BAZ` (an environment variable)",
	]);
});

test("the overview pages carry no command, variable, settings path or file path", () => {
	const found: string[] = [];
	for (const file of OVERVIEW_PAGES) {
		const markdown = readFileSync(join(ROOT, file), "utf8");
		expect(markdown.length, file).toBeGreaterThan(0);
		for (const hit of overviewDetail(markdown)) found.push(`${file}:${hit}`);
	}
	expect(found).toEqual([]);
	// Every allowed span is still on a page, so the list never outlives its reason.
	const text = OVERVIEW_PAGES.map((file) =>
		readFileSync(join(ROOT, file), "utf8"),
	).join("\n");
	for (const code of OVERVIEW_CODE_ALLOWED.keys())
		expect(text.includes(`\`${code}\``), code).toBe(true);
});
