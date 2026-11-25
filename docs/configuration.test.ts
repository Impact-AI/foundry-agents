/**
 * configuration.md cannot drift from the code in its names. Every deployment
 * parameter and azd variable the template reads, every environment variable
 * either app's container is given, and every field of every settings
 * document the migrate job seeds is a row of its table, and every row names
 * something that exists. The sources are the ones the template's own tests
 * hold equal to the apps: `infra/main.bicep` and `main.parameters.json`, the
 * env lists in the two app modules, and `configDocuments()`, the defaults the
 * settings step writes.
 *
 * Defaults are held where the source spells one as a literal: a parameter's
 * literal default or its variable's fallback in the parameter file, an
 * environment value that is a literal in the template, a number written
 * beside the name in an `envInt` call, and every settings field's default.
 * A default that is a Bicep expression or a named constant is not compared,
 * and neither is any rule or effect a row describes: those are prose a
 * person checks. The "Set by the images" paragraph has no test, and the
 * "Read outside a deployment" table is checked one way: every name in a
 * row's first cell is read from the environment somewhere in the sources,
 * tests and workflows among them.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	codeSpans,
	repositoryRoot,
	section,
	subsections,
	tableRows,
} from "./markdown";

const ROOT = repositoryRoot();
const HERE = import.meta.dir;
const INFRA = join(HERE, "..", "infra");
const page = readFileSync(join(HERE, "configuration.md"), "utf8");
const read = (path: string) => readFileSync(path, "utf8");

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

// --- deployment parameters ---------------------------------------------

const bicep = read(join(INFRA, "main.bicep"));
const parameterFile = read(join(INFRA, "main.parameters.json"));

/** Every `param` of main.bicep, with its default when that is a plain literal. */
function bicepParameters(): Map<string, string | undefined> {
	const out = new Map<string, string | undefined>();
	for (const m of bicep.matchAll(/^param (\w+) [^=\n]+(?:= (.+))?$/gm)) {
		const literal = m[2]?.trim().match(/^(?:'([^'$]*)'|(\d+|true|false))$/);
		out.set(m[1] as string, literal ? (literal[1] ?? literal[2]) : undefined);
	}
	return out;
}

/** Every azd variable main.parameters.json substitutes, with its default. */
function azdVariables(): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of parameterFile.matchAll(
		/\$\{([A-Z][A-Z0-9_]*)(?:=([^}]*))?\}/g,
	))
		out.set(m[1] as string, m[2] ?? "");
	return out;
}

const parameterRows = tableRows(section(page, 2, "Deployment parameters"));

test("every Bicep parameter has a row, and every row names a parameter", () => {
	const documented = parameterRows.flatMap((row) => codeSpans(row[1] ?? ""));
	expect(sorted(documented)).toEqual(sorted(bicepParameters().keys()));
});

test("every azd variable the parameter file reads has a row, and every row names one", () => {
	const documented = parameterRows.flatMap((row) => codeSpans(row[0] ?? ""));
	expect(sorted(documented)).toEqual(sorted(azdVariables().keys()));
});

test("each parameter's documented default is the template's", () => {
	const parameters = bicepParameters();
	const variables = azdVariables();
	const wrong: string[] = [];
	for (const [
		variableCell = "",
		parameterCell = "",
		defaultCell = "",
	] of parameterRows) {
		const [variable, ...moreVariables] = codeSpans(variableCell);
		const [parameter, ...moreParameters] = codeSpans(parameterCell);
		if (!parameter || moreVariables.length || moreParameters.length) continue;
		const expected = variable
			? variables.get(variable)
			: parameters.get(parameter);
		if (expected && !codeSpans(defaultCell).includes(expected))
			wrong.push(`${parameter}: wants \`${expected}\` in "${defaultCell}"`);
	}
	expect(wrong).toEqual([]);
});

// --- environment variables ---------------------------------------------

interface TemplateVariable {
	name: string;
	value?: string;
	secret: boolean;
}

/**
 * The `env` list of an app module, in the order the template writes it. An
 * entry the deployment decides is a variable of its own, written `var x =
 * <condition>` with a `?` branch on the next line; it is read as that branch,
 * the vault reference it is where it is set.
 */
function templateEnvironment(module: string): TemplateVariable[] {
	const text = read(join(INFRA, "modules", module));
	const list = (/^var env = \[\n([\s\S]*?)^\]/m.exec(text)?.[1] ?? "")
		.split("\n")
		.map((line) => {
			const named = /^\s+(\w+)\s*$/.exec(line)?.[1];
			if (!named) return line;
			return (
				new RegExp(
					`^var ${named} = [^\\n]*\\n\\s+\\? (\\{[^\\n]*\\})`,
					"m",
				).exec(text)?.[1] ?? line
			);
		})
		.join("\n");
	return [
		...list.matchAll(/\{ name: '(\w+)', (value|secretRef): ([^}]+) \}/g),
	].map((m) => ({
		name: m[1] as string,
		secret: m[2] === "secretRef",
		value: /^'([^']*)'$/.exec((m[3] as string).trim())?.[1],
	}));
}

/** The variables the migrate job sets differently from the backend. */
function jobOverrides(): string[] {
	const text = read(join(INFRA, "modules", "backend.bicep"));
	const block = /^var jobOverrides = \{\n([\s\S]*?)^\}/m.exec(text)?.[1] ?? "";
	return [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1] as string);
}

const SOURCE_TREES = [
	"platform",
	"apps/backend",
	"apps/frontend",
	"infra",
	"hooks",
	"scripts",
	".github",
];
const SKIP = new Set(["node_modules", ".next", "docs"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (/\.(ts|tsx|sh|ps1|yml)$/.test(name)) out.push(path);
	}
	return out;
}

const sources = SOURCE_TREES.flatMap((tree) =>
	sourceFiles(join(ROOT, tree)),
).map(read);

/** Each variable's compiled-in default, where the code spells it as a number beside the name. */
function codeDefaults(): Map<string, string> {
	const out = new Map<string, string>();
	for (const text of sources)
		for (const m of text.matchAll(
			/\benvInt\(\s*"([A-Z0-9_]+)",\s*([\d_]+)\s*[,)]/g,
		))
			out.set(m[1] as string, (m[2] as string).replaceAll("_", ""));
	return out;
}

const environment = section(page, 2, "Environment variables");
const appTables = subsections(environment, 3);

function rowsOf(title: string): string[][] {
	const body = appTables.get(title);
	if (body === undefined)
		throw new Error(`no "### ${title}" under Environment variables`);
	return tableRows(body);
}

for (const [title, module] of [
	["Backend", "backend.bicep"],
	["Frontend", "frontend.bicep"],
] as const) {
	test(`${title}: the table is exactly the template's environment`, () => {
		const documented = rowsOf(title).map((row) => codeSpans(row[0] ?? "")[0]);
		expect(documented).toEqual(templateEnvironment(module).map((v) => v.name));
	});

	test(`${title}: Key Vault is named for exactly the secret references`, () => {
		const byName = new Map(
			rowsOf(title).map((row) => [codeSpans(row[0] ?? "")[0], row[1] ?? ""]),
		);
		const wrong = templateEnvironment(module)
			.filter(
				(v) => v.secret !== (byName.get(v.name) ?? "").includes("Key Vault"),
			)
			.map((v) => v.name);
		expect(wrong).toEqual([]);
	});

	test(`${title}: a literal the template sets, and a default the code compiles in, are the documented ones`, () => {
		const defaults = codeDefaults();
		const byName = new Map(
			rowsOf(title).map((row) => [codeSpans(row[0] ?? "")[0], row[1] ?? ""]),
		);
		const wrong: string[] = [];
		for (const { name, value } of templateEnvironment(module)) {
			const cell = byName.get(name) ?? "";
			if (value === "") {
				if (!cell.startsWith("empty"))
					wrong.push(`${name}: the template sets it empty`);
				const fallback = defaults.get(name);
				if (fallback && !codeSpans(cell).includes(fallback))
					wrong.push(`${name}: the code's default is ${fallback}`);
			} else if (value !== undefined && !codeSpans(cell).includes(value)) {
				wrong.push(`${name}: the template sets \`${value}\``);
			}
		}
		expect(wrong).toEqual([]);
	});
}

test("the migrate job's table is exactly what the template overrides", () => {
	const documented = rowsOf("Migrate job").map(
		(row) => codeSpans(row[0] ?? "")[0],
	);
	expect(sorted(documented)).toEqual(sorted(jobOverrides()));
});

/** Whether `text` reads the variable `name`: off `env`, by a quoted name, or as a shell's. */
const reads = (text: string, name: string) =>
	new RegExp(`(?:\\benv\\.|["'\`]|\\$\\{?)${name}\\b`).test(text);

test("every variable read outside a deployment is read somewhere", () => {
	const unread = rowsOf("Read outside a deployment")
		.flatMap((row) => codeSpans(row[0] ?? ""))
		.filter((name) => !sources.some((text) => reads(text, name)));
	expect(unread).toEqual([]);
});

// --- settings documents ------------------------------------------------

/** Every leaf of a document by its dotted path; a list is a leaf. */
function leaves(value: unknown, path = ""): [string, unknown][] {
	if (value && typeof value === "object" && !Array.isArray(value))
		return Object.entries(value).flatMap(([key, v]) =>
			leaves(v, path ? `${path}.${key}` : key),
		);
	return [[path, value]];
}

const documents = subsections(section(page, 2, "Settings documents"), 3);

test("every settings document the job seeds has a section, and every section is one", async () => {
	const { configDocuments } = await import(
		join(ROOT, "apps", "backend", "src", "config-documents.ts")
	);
	const documented = [...documents.keys()].flatMap((title) => {
		const name = /^`([a-z]+)`$/.exec(title)?.[1];
		return name ? [name] : [];
	});
	expect(sorted(documented)).toEqual(sorted(Object.keys(configDocuments())));
});

test("every field of every settings document has a row with the code's default, and nothing else does", async () => {
	const { configDocuments } = await import(
		join(ROOT, "apps", "backend", "src", "config-documents.ts")
	);
	const wrong: string[] = [];
	for (const [name, value] of Object.entries(
		configDocuments() as Record<string, unknown>,
	)) {
		const rows = tableRows(documents.get(`\`${name}\``) ?? "");
		const documented = new Map(
			rows.map((row) => [codeSpans(row[0] ?? "")[0], row[1] ?? ""]),
		);
		const fields = leaves(value);
		expect(sorted(documented.keys()), name).toEqual(
			sorted(fields.map(([path]) => path)),
		);
		for (const [path, fallback] of fields) {
			const want = JSON.stringify(fallback);
			if (!codeSpans(documented.get(path) ?? "").includes(want))
				wrong.push(`${name}.${path}: wants \`${want}\``);
		}
	}
	expect(wrong).toEqual([]);
});
