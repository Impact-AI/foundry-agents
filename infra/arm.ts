/**
 * The compiled template, read as data. `bicep build --stdout` on main.bicep
 * gives one ARM document with every module inlined as a nested deployment,
 * each parameterised by expressions. The tests here never match Bicep source:
 * they instantiate that document with a parameter set, evaluating the ARM
 * expression language far enough to read names, tags, parameters and
 * conditions, and leave anything only a live deployment can answer (a
 * `reference()`, a `listKeys()`) as an opaque value. Rewrite the Bicep any
 * way you like; what the tests hold is the compiled shape.
 *
 * Where the language refuses, so does this: a property an object does not
 * have is an error on the resource that read it (only `tryGet` asks
 * leniently), and `and` and `or` stop at the argument that decides them, so a
 * module's `contains(x, 'p') && x.p` reads as it does in a deployment.
 *
 * `what-if` cannot run here: it needs a subscription, and so does the only
 * check this evaluator does not replace, that Azure accepts each SKU in the
 * chosen region.
 *
 * Long for one reason: the expression language is one thing, and splitting
 * its parser, its functions and the instantiation across files would give
 * every test three imports for one idea.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INFRA = new URL(".", import.meta.url).pathname;

/**
 * ARM's `union` of objects: a later key overwrites an earlier one, nested
 * objects merge recursively, arrays are replaced whole. A null does not
 * replace a value already there — what a deployment did with
 * `{ role: cond ? {...} : null }` over a role the parameter file set, leaving
 * the file's object in place for the account to read a capacity from.
 */
function mergeObjects(
	into: Record<string, unknown>,
	from: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...into };
	for (const [key, value] of Object.entries(from ?? {})) {
		const held = out[key];
		if (value === null && held !== undefined && held !== null) continue;
		out[key] =
			isPlainObject(held) && isPlainObject(value)
				? mergeObjects(held, value)
				: value;
	}
	return out;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return (
		typeof x === "object" && x !== null && !Array.isArray(x) && !isOpaque(x)
	);
}

type UserFunction = {
	parameters?: { name: string }[];
	output: { value: unknown };
};

export type Template = {
	parameters?: Record<string, ParameterDeclaration>;
	functions?: { namespace: string; members: Record<string, UserFunction> }[];
	variables?: Record<string, unknown>;
	resources?: Record<string, RawResource> | RawResource[];
	outputs?: Record<string, { type: string; value: unknown }>;
	metadata?: { name?: string };
};

type ParameterDeclaration = {
	type: string;
	defaultValue?: unknown;
	nullable?: boolean;
};

type RawResource = {
	type: string;
	apiVersion?: string;
	name?: unknown;
	condition?: unknown;
	copy?: { name: string; count: unknown };
	properties?: Record<string, unknown>;
	tags?: unknown;
	scope?: unknown;
	resourceGroup?: unknown;
	[key: string]: unknown;
};

export type Resource = {
	symbol: string;
	type: string;
	name: unknown;
	condition: boolean;
	properties: unknown;
	tags: unknown;
	/** An extension resource's target, such as the account a role assignment is on. */
	scope?: unknown;
	/** The availability zones a resource is pinned to, where it declares any. */
	zones?: unknown;
	/** The symbols, in the same deployment, this one waits for. */
	dependsOn: string[];
	copyIndex?: number;
	/** The instantiated nested deployment, for a `Microsoft.Resources/deployments`. */
	deployment?: Deployment;
	error?: string;
};

export type Deployment = {
	name: string;
	template: Template;
	parameters: Record<string, unknown>;
	resources: Resource[];
	/** Each output's value, or undefined where evaluating it failed. */
	outputs: Record<string, unknown>;
	/**
	 * What failed outside any one resource: a copy loop whose count could not
	 * be evaluated, which makes no resource to carry the error, and an output.
	 */
	errors: string[];
};

/** A value only a live deployment can answer. Property access keeps the path. */
class Opaque {
	constructor(readonly path: string) {}
	get(key: string): Opaque {
		return new Opaque(`${this.path}.${key}`);
	}
	toString(): string {
		return `<${this.path}>`;
	}
}

// --- the compiler ----------------------------------------------------------

/**
 * The Bicep CLI to compile with: the one `BICEP_CLI` names, else `bicep` on
 * PATH, else `az bicep`; null when there is none, which is what lets the
 * compiled checks skip. A `BICEP_CLI` that names no file is a mistake, not an
 * absence: it throws, so a run that was told which compiler to use never
 * skips, or picks another, without saying.
 */
export function bicepCommand(): string[] | null {
	const pinned = process.env.BICEP_CLI;
	if (pinned) {
		if (!existsSync(pinned))
			throw new Error(
				`BICEP_CLI names ${pinned}, which does not exist; unset it to use bicep on PATH or az bicep, or point it at the Bicep CLI`,
			);
		return [pinned];
	}
	if (Bun.which("bicep")) return ["bicep"];
	if (Bun.which("az")) return ["az", "bicep"];
	return null;
}

const COMPILED = "azd-infra:compiled-main";

/** The compiled main template, once per process, or null when no Bicep CLI is installed. */
export function compiledMain(): Template | null {
	const g = globalThis as Record<string, unknown>;
	if (!(COMPILED in g)) g[COMPILED] = compile(join(INFRA, "main.bicep"));
	return g[COMPILED] as Template | null;
}

function compile(file: string): Template | null {
	const command = bicepCommand();
	if (!command) return null;
	// The standalone CLI takes the file positionally; `az bicep` wants --file.
	const fileArgs = command[0] === "az" ? ["--file", file] : [file];
	const proc = Bun.spawnSync([...command, "build", ...fileArgs, "--stdout"], {
		stderr: "pipe",
		stdout: "pipe",
	});
	const out = new TextDecoder().decode(proc.stdout);
	if (proc.exitCode !== 0 || !out.trim()) {
		throw new Error(
			`bicep build failed:\n${new TextDecoder().decode(proc.stderr)}`,
		);
	}
	return JSON.parse(out) as Template;
}

// --- parameters -----------------------------------------------------------

/** main.parameters.json with azd's `${VAR}` / `${VAR=default}` substitution applied, at every depth as azd does it. */
export function parameterFile(
	env: Record<string, string>,
): Record<string, unknown> {
	const raw = JSON.parse(
		readFileSync(join(INFRA, "main.parameters.json"), "utf8"),
	) as { parameters: Record<string, { value: unknown }> };
	const substitute = (value: unknown): unknown => {
		if (typeof value === "string")
			return value.replace(/\$\{([A-Z_]+)(?:=([^}]*))?\}/g, (_, v, d) =>
				v in env ? env[v] : (d ?? ""),
			);
		if (Array.isArray(value)) return value.map(substitute);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, substitute(v)]),
			);
		return value;
	};
	const out: Record<string, unknown> = {};
	for (const [name, { value }] of Object.entries(raw.parameters))
		out[name] = substitute(value);
	return out;
}

/** Everything a test needs to instantiate main.bicep; override per case. */
function sampleParameters(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		...parameterFile({
			AZURE_ENV_NAME: "sample",
			AZURE_LOCATION: "westeurope",
			AZURE_PRINCIPAL_ID: "11111111-2222-3333-4444-555555555555",
			AUTH_SECRET: "auth",
		}),
		...overrides,
	};
}

// --- the expression language ----------------------------------------------

type Scope = {
	deploymentName: string;
	parameters: Record<string, unknown>;
	declarations: Record<string, ParameterDeclaration>;
	functions: Record<string, UserFunction>;
	variables: Record<string, unknown>;
	resolved: Map<string, unknown>;
	copyIndex: Record<string, number>;
	lambdas: Record<string, unknown>;
};

type Node =
	| { kind: "string"; value: string }
	| { kind: "number"; value: number }
	| { kind: "call"; name: string; args: Node[] }
	| { kind: "property"; target: Node; name: string }
	| { kind: "index"; target: Node; index: Node };

class Parser {
	private pos = 0;
	constructor(private readonly src: string) {}

	parse(): Node {
		const node = this.expression();
		this.skip();
		if (this.pos !== this.src.length)
			throw new Error(
				`unexpected '${this.src.slice(this.pos)}' in ${this.src}`,
			);
		return node;
	}

	private skip() {
		while (this.pos < this.src.length && /\s/.test(this.src[this.pos]))
			this.pos++;
	}

	private expression(): Node {
		let node = this.primary();
		for (;;) {
			this.skip();
			if (this.src[this.pos] === ".") {
				this.pos++;
				const start = this.pos;
				while (this.pos < this.src.length && /[\w$]/.test(this.src[this.pos]))
					this.pos++;
				node = {
					kind: "property",
					target: node,
					name: this.src.slice(start, this.pos),
				};
			} else if (this.src[this.pos] === "[") {
				this.pos++;
				const index = this.expression();
				this.skip();
				if (this.src[this.pos] !== "]")
					throw new Error(`expected ] in ${this.src}`);
				this.pos++;
				node = { kind: "index", target: node, index };
			} else return node;
		}
	}

	private primary(): Node {
		this.skip();
		const c = this.src[this.pos];
		if (c === "'") {
			this.pos++;
			let value = "";
			for (;;) {
				const ch = this.src[this.pos++];
				if (ch === undefined)
					throw new Error(`unterminated string in ${this.src}`);
				if (ch === "'") {
					if (this.src[this.pos] === "'") {
						value += "'";
						this.pos++;
					} else break;
				} else value += ch;
			}
			return { kind: "string", value };
		}
		if (/[-\d]/.test(c)) {
			const start = this.pos;
			this.pos++;
			while (this.pos < this.src.length && /\d/.test(this.src[this.pos]))
				this.pos++;
			return { kind: "number", value: Number(this.src.slice(start, this.pos)) };
		}
		const start = this.pos;
		// A user-defined function is called through its namespace: `__bicep.f(...)`.
		while (this.pos < this.src.length && /[\w.]/.test(this.src[this.pos]))
			this.pos++;
		const name = this.src.slice(start, this.pos).toLowerCase();
		if (!name) throw new Error(`cannot parse '${this.src}' at ${this.pos}`);
		this.skip();
		if (this.src[this.pos] !== "(")
			throw new Error(`expected ( after ${name} in ${this.src}`);
		this.pos++;
		const args: Node[] = [];
		this.skip();
		if (this.src[this.pos] === ")") {
			this.pos++;
			return { kind: "call", name, args };
		}
		for (;;) {
			args.push(this.expression());
			this.skip();
			if (this.src[this.pos] === ",") {
				this.pos++;
				continue;
			}
			if (this.src[this.pos] === ")") {
				this.pos++;
				return { kind: "call", name, args };
			}
			throw new Error(`expected , or ) in ${this.src}`);
		}
	}
}

const GUID = "00000000-0000-4000-8000-000000000000";
const SUBSCRIPTION_ID = "99999999-8888-7777-6666-555555555555";

/** Thirteen characters, like the real one, derived from the arguments so two calls agree. */
function uniqueString(parts: unknown[]): string {
	let h = 2166136261;
	for (const ch of parts.map(String).join("|")) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return `${h.toString(36)}abcdefghijklm`.slice(0, 13);
}

function isOpaque(v: unknown): v is Opaque {
	return v instanceof Opaque;
}

function stringOf(v: unknown): string {
	if (isOpaque(v)) return v.toString();
	if (v === null || v === undefined) return "";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

function truthy(v: unknown): boolean {
	if (isOpaque(v)) return false;
	return v === true;
}

function isEmpty(v: unknown): boolean {
	if (isOpaque(v)) return false;
	if (v === null || v === undefined) return true;
	if (typeof v === "string" || Array.isArray(v)) return v.length === 0;
	if (typeof v === "object") return Object.keys(v as object).length === 0;
	return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (isOpaque(a) || isOpaque(b)) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/** What a value is, for the error that says it was read as an object. */
function describe(value: unknown): string {
	if (value === null || value === undefined) return "null";
	return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

function access(target: unknown, key: string | number): unknown {
	if (isOpaque(target)) return target.get(String(key));
	if (target === null || target === undefined) return null;
	if (typeof target !== "object") return null;
	return (target as Record<string, unknown>)[key as string] ?? null;
}

type PropertyCopy = { name: string; count: unknown; input: unknown };
function isPropertyCopy(v: unknown): v is PropertyCopy[] {
	return (
		Array.isArray(v) &&
		v.length > 0 &&
		v.every(
			(x) =>
				x !== null &&
				typeof x === "object" &&
				typeof (x as PropertyCopy).name === "string" &&
				"count" in x &&
				"input" in x,
		)
	);
}

class Evaluator {
	constructor(private readonly scope: Scope) {}

	/** Evaluate a JSON value: strings in `[...]` are expressions, the rest recurses. */
	value(v: unknown): unknown {
		if (typeof v === "string") {
			if (v.startsWith("[[")) return v.slice(1);
			if (v.startsWith("[") && v.endsWith("]"))
				return this.node(new Parser(v.slice(1, -1)).parse());
			return v;
		}
		if (Array.isArray(v)) return v.map((x) => this.value(x));
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) {
				// A property copy loop: each entry becomes an array under its
				// name, of its input once for each index, and none for a count
				// of zero.
				if (k === "copy" && isPropertyCopy(x)) {
					for (const loop of x) {
						// A loop over a list only the live deployment answers is as long as that list.
						const live = this.liveLength(loop.count);
						if (live) {
							out[loop.name] = live;
							continue;
						}
						const count = Number(this.value(loop.count));
						const items: unknown[] = [];
						for (let i = 0; i < count; i++)
							items.push(
								new Evaluator({
									...this.scope,
									copyIndex: {
										...this.scope.copyIndex,
										[loop.name]: i,
									},
								}).value(loop.input),
							);
						out[loop.name] = items;
					}
					continue;
				}
				out[k] = this.value(x);
			}
			return out;
		}
		return v;
	}

	/** The live list a count measures, where it is `length()` of one. */
	private liveLength(count: unknown): Opaque | null {
		if (typeof count !== "string" || !count.startsWith("[")) return null;
		const node = new Parser(count.slice(1, -1)).parse();
		if (node.kind !== "call" || node.name.toLowerCase() !== "length")
			return null;
		const [of] = node.args;
		const list = of ? this.node(of) : null;
		return isOpaque(list) ? new Opaque(`copy(${list.path})`) : null;
	}

	variable(name: string): unknown {
		const cache = this.scope.resolved;
		if (cache.has(name)) return cache.get(name);
		const declared = this.scope.variables[name];
		if (declared === undefined) {
			const copies = this.scope.variables.copy as
				| { name: string; count: unknown; input: unknown }[]
				| undefined;
			const loop = copies?.find((c) => c.name === name);
			if (!loop) throw new Error(`variable ${name} is not declared`);
			const count = this.value(loop.count) as number;
			const out: unknown[] = [];
			for (let i = 0; i < count; i++) {
				const inner = new Evaluator({
					...this.scope,
					copyIndex: { ...this.scope.copyIndex, [name]: i, "": i },
				});
				out.push(inner.value(loop.input));
			}
			cache.set(name, out);
			return out;
		}
		const resolved = this.value(declared);
		cache.set(name, resolved);
		return resolved;
	}

	parameter(name: string): unknown {
		const declaration = this.scope.declarations[name];
		// A null handed to a parameter is no value: its default stands, which is how a module's optional argument reaches a nested deployment.
		const bound = this.scope.parameters[name];
		if (
			name in this.scope.parameters &&
			!(bound === null && declaration && "defaultValue" in declaration)
		)
			return bound;
		if (!declaration) throw new Error(`parameter ${name} is not declared`);
		if ("defaultValue" in declaration)
			return this.value(declaration.defaultValue);
		return null;
	}

	private node(n: Node): unknown {
		switch (n.kind) {
			case "string":
				return n.value;
			case "number":
				return n.value;
			case "property": {
				// ARM refuses a property of null, of anything that is not an
				// object, and one an object does not have; only `tryGet` (what
				// Bicep's `.?` compiles to) asks leniently.
				const target = this.node(n.target);
				if (isOpaque(target)) return target.get(n.name);
				if (
					target === null ||
					target === undefined ||
					typeof target !== "object" ||
					Array.isArray(target)
				)
					throw new Error(
						`property '${n.name}' was read of ${describe(target)}, which has none`,
					);
				if (!(n.name in target))
					throw new Error(`the object has no property '${n.name}'`);
				return access(target, n.name);
			}
			case "index": {
				// An index is held to the same: past an array's end, a key an
				// object lacks and an index of null are each refused.
				const target = this.node(n.target);
				const index = this.node(n.index);
				if (isOpaque(target)) return target.get(stringOf(index));
				if (isOpaque(index)) return new Opaque(`${stringOf(target)}[${index}]`);
				if (Array.isArray(target)) {
					if (
						typeof index !== "number" ||
						!Number.isInteger(index) ||
						index < 0 ||
						index >= target.length
					)
						throw new Error(
							`index ${stringOf(index)} is outside an array of ${target.length}`,
						);
					return target[index];
				}
				if (
					target === null ||
					target === undefined ||
					typeof target !== "object"
				)
					throw new Error(
						`index '${stringOf(index)}' was read of ${describe(target)}, which has none`,
					);
				if (!(String(index) in target))
					throw new Error(`the object has no property '${stringOf(index)}'`);
				return access(target, index as string);
			}
			case "call":
				return this.call(n.name, n.args);
		}
	}

	private call(name: string, argNodes: Node[]): unknown {
		if (name === "lambda") {
			const names = argNodes
				.slice(0, -1)
				.map((a) => (a.kind === "string" ? a.value : ""));
			const body = argNodes[argNodes.length - 1];
			return (...values: unknown[]) => {
				const lambdas = { ...this.scope.lambdas };
				names.forEach((n, i) => {
					lambdas[n] = values[i];
				});
				return new Evaluator({ ...this.scope, lambdas }).node(body);
			};
		}
		// Lazy, as in ARM: the branch not taken may be a fail().
		if (name === "if")
			return truthy(this.node(argNodes[0]))
				? this.node(argNodes[1])
				: this.node(argNodes[2]);
		// Short-circuit, as in ARM: a module guards a property with `contains` before it reads it.
		if (name === "and") return argNodes.every((a) => truthy(this.node(a)));
		if (name === "or") return argNodes.some((a) => truthy(this.node(a)));
		const args = argNodes.map((a) => this.node(a));
		const a = args as never[];
		const defined = this.scope.functions[name];
		if (defined) {
			const parameters: Record<string, unknown> = {};
			(defined.parameters ?? []).forEach((p, i) => {
				parameters[p.name] = args[i];
			});
			return new Evaluator({
				...this.scope,
				parameters,
				declarations: {},
				resolved: new Map(),
			}).value(defined.output.value);
		}
		switch (name) {
			case "true":
				return true;
			case "false":
				return false;
			case "parameters":
				return this.parameter(a[0]);
			case "variables":
				return this.variable(a[0]);
			case "lambdavariables":
				return this.scope.lambdas[a[0]];
			case "copyindex": {
				const loop = typeof a[0] === "string" ? (a[0] as string) : "";
				const offset =
					typeof a[0] === "number" ? (a[0] as number) : ((a[1] as number) ?? 0);
				return (
					(this.scope.copyIndex[loop] ?? this.scope.copyIndex[""] ?? 0) + offset
				);
			}
			case "fail":
				throw new Error(`fail(): ${stringOf(args[0])}`);
			case "equals":
				return deepEqual(args[0], args[1]);
			case "not":
				return !truthy(args[0]);
			case "bool":
				return args[0] === true || args[0] === "true";
			case "empty":
				return isEmpty(args[0]);
			case "null":
				return null;
			case "coalesce":
				return args.find((x) => x !== null && x !== undefined) ?? null;
			case "tryget":
				return isEmpty(args[0]) && !isOpaque(args[0])
					? null
					: access(args[0], a[1]);
			case "format":
				// .NET's composite format: a doubled brace is a literal one.
				return (a[0] as string).replace(
					/\{\{|\}\}|\{(\d+)\}/g,
					(token, i: string | undefined) =>
						i === undefined ? token[0] : stringOf(args[Number(i) + 1]),
				);
			case "concat":
				return Array.isArray(args[0])
					? args.flatMap((x) => x as unknown[])
					: args.map(stringOf).join("");
			case "createarray":
				return args;
			case "createobject": {
				const out: Record<string, unknown> = {};
				for (let i = 0; i < args.length; i += 2) out[a[i]] = args[i + 1];
				return out;
			}
			case "string":
				return stringOf(args[0]);
			case "int":
				return Number(args[0]);
			case "json":
				return JSON.parse(a[0]);
			case "array":
				return Array.isArray(args[0]) ? args[0] : [args[0]];
			case "length":
				if (isOpaque(args[0]) || args[0] === null || args[0] === undefined)
					return 0;
				return Array.isArray(args[0]) || typeof args[0] === "string"
					? (args[0] as unknown[]).length
					: Object.keys(args[0] as object).length;
			case "first":
				return Array.isArray(args[0])
					? (args[0][0] ?? null)
					: (a[0] as string)[0];
			case "last":
				return Array.isArray(args[0])
					? (args[0][args[0].length - 1] ?? null)
					: (a[0] as string).slice(-1);
			case "take":
				return Array.isArray(args[0])
					? args[0].slice(0, a[1])
					: (a[0] as string).slice(0, a[1]);
			case "skip":
				return Array.isArray(args[0])
					? args[0].slice(a[1])
					: (a[0] as string).slice(a[1]);
			case "union":
				return Array.isArray(args[0])
					? [...new Set(args.flatMap((x) => x as unknown[]))]
					: (args as Record<string, unknown>[]).reduce(mergeObjects, {});
			case "shallowmerge":
				return Object.assign({}, ...((args[0] as object[]) ?? []));
			case "items":
				return Object.entries((args[0] as object) ?? {}).map(
					([key, value]) => ({ key, value }),
				);
			case "objectkeys":
				return Object.keys((args[0] as object) ?? {});
			case "tolower":
				return stringOf(args[0]).toLowerCase();
			case "toupper":
				return stringOf(args[0]).toUpperCase();
			case "trim":
				return stringOf(args[0]).trim();
			case "padleft":
				return stringOf(args[0]).padStart(a[1], a[2] ?? " ");
			case "startswith":
				return stringOf(args[0]).startsWith(a[1]);
			case "endswith":
				return stringOf(args[0]).endsWith(a[1]);
			case "contains":
				return Array.isArray(args[0])
					? args[0].some((x) => deepEqual(x, args[1]))
					: typeof args[0] === "object" &&
							args[0] !== null &&
							!isOpaque(args[0])
						? a[1] in (args[0] as object)
						: stringOf(args[0]).includes(stringOf(args[1]));
			case "split":
				return stringOf(args[0]).split(a[1]);
			case "replace":
				return stringOf(args[0]).split(a[1]).join(a[2]);
			case "substring":
				return stringOf(args[0]).substring(
					a[1],
					a[2] === undefined ? undefined : (a[1] as number) + (a[2] as number),
				);
			case "indexof":
				return stringOf(args[0]).indexOf(a[1]);
			case "lastindexof":
				return stringOf(args[0]).lastIndexOf(a[1]);
			case "range":
				return Array.from({ length: a[1] }, (_, i) => (a[0] as number) + i);
			case "min":
				return Math.min(
					...(Array.isArray(args[0])
						? (args[0] as number[])
						: (args as number[])),
				);
			case "max":
				return Math.max(
					...(Array.isArray(args[0])
						? (args[0] as number[])
						: (args as number[])),
				);
			case "add":
				return (a[0] as number) + (a[1] as number);
			case "sub":
				return (a[0] as number) - (a[1] as number);
			case "mul":
				return (a[0] as number) * (a[1] as number);
			case "div":
				return Math.trunc((a[0] as number) / (a[1] as number));
			case "mod":
				return (a[0] as number) % (a[1] as number);
			case "greater":
				return (a[0] as number) > (a[1] as number);
			case "greaterorequals":
				return (a[0] as number) >= (a[1] as number);
			case "less":
				return (a[0] as number) < (a[1] as number);
			case "lessorequals":
				return (a[0] as number) <= (a[1] as number);
			case "map":
			case "filter":
			case "sort":
			case "flatten":
				// A list only the live deployment answers stays one whatever is asked of it.
				if (isOpaque(args[0]))
					return new Opaque(`${name}(${stringOf(args[0])})`);
				return this.listed(name, args);
			default:
				return this.more(name, args);
		}
	}

	/** The list functions over a list this evaluation holds. */
	private listed(name: string, args: unknown[]): unknown {
		switch (name) {
			case "map":
				return (args[0] as unknown[]).map((x, i) =>
					(args[1] as (...v: unknown[]) => unknown)(x, i),
				);
			case "filter":
				return (args[0] as unknown[]).filter((x, i) =>
					truthy((args[1] as (...v: unknown[]) => unknown)(x, i)),
				);
			case "sort":
				return [...(args[0] as unknown[])];
			case "flatten":
				return (args[0] as unknown[][]).flat();
			default:
				throw new Error(`unsupported function ${name}`);
		}
	}

	private more(name: string, args: unknown[]): unknown {
		switch (name) {
			case "reduce":
				return (args[0] as unknown[]).reduce(
					(acc, x, i) => (args[2] as (...v: unknown[]) => unknown)(acc, x, i),
					args[1],
				);
			case "toobject": {
				// An app's own settings read back from it: an object only the live deployment answers.
				if (isOpaque(args[0]))
					return new Opaque(`toObject(${stringOf(args[0])})`);
				const out: Record<string, unknown> = {};
				for (const x of args[0] as unknown[]) {
					const key = stringOf((args[1] as (...v: unknown[]) => unknown)(x));
					out[key] = args[2] ? (args[2] as (...v: unknown[]) => unknown)(x) : x;
				}
				return out;
			}
			case "intersection":
				return Array.isArray(args[0])
					? args[0].filter((x) =>
							(args[1] as unknown[]).some((y) => deepEqual(x, y)),
						)
					: {};
			case "uniquestring":
				return uniqueString(args);
			case "guid":
			case "newguid":
				return GUID;
			case "base64":
			case "uri":
			case "uricomponent":
			case "datetimeadd":
			case "datetimefromepoch":
			case "utcnow":
				return stringOf(args[0] ?? "");
			case "subscription":
				return {
					id: `/subscriptions/${SUBSCRIPTION_ID}`,
					subscriptionId: SUBSCRIPTION_ID,
					tenantId: GUID,
					displayName: "sample",
				};
			case "tenant":
				return { tenantId: GUID };
			case "resourcegroup":
				return {
					id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-sample`,
					name: "rg-sample",
					location: "westeurope",
				};
			case "deployment":
				return { name: this.scope.deploymentName, location: "westeurope" };
			case "environment":
				return {
					name: "AzureCloud",
					authentication: {
						loginEndpoint: "https://login.microsoftonline.com/",
					},
					suffixes: {
						storage: "core.windows.net",
						keyvaultDns: ".vault.azure.net",
						acrLoginServer: ".azurecr.io",
					},
				};
			case "resourceid":
			case "subscriptionresourceid":
			case "tenantresourceid":
			case "extensionresourceid":
			case "managementgroupresourceid":
				return `/resource/${args.map(stringOf).join("/")}`;
			case "reference":
				return new Opaque(`${name}(${args.map(stringOf).join(",")})`);
			default:
				// Every `list*` function asks a resource provider at deployment time.
				if (name.startsWith("list"))
					return new Opaque(`${name}(${args.map(stringOf).join(",")})`);
				throw new Error(`unsupported function ${name}`);
		}
	}
}

// --- instantiation --------------------------------------------------------

function coerce(value: unknown, declaration?: ParameterDeclaration): unknown {
	if (typeof value !== "string" || !declaration) return value;
	if (declaration.type === "bool") return value === "true";
	if (declaration.type === "int") return Number(value);
	return value;
}

/** Instantiate a template with concrete parameters, recursing into every nested deployment. */
export function instantiate(
	template: Template,
	parameters: Record<string, unknown>,
	deploymentName = "main",
): Deployment {
	const declarations = template.parameters ?? {};
	const bound: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(parameters))
		bound[k] = coerce(v, declarations[k]);
	const functions: Record<string, UserFunction> = {};
	for (const ns of template.functions ?? [])
		for (const [member, fn] of Object.entries(ns.members))
			functions[`${ns.namespace}.${member}`.toLowerCase()] = fn;
	const scope: Scope = {
		deploymentName,
		parameters: bound,
		declarations,
		functions,
		variables: template.variables ?? {},
		resolved: new Map(),
		copyIndex: {},
		lambdas: {},
	};
	const deployment: Deployment = {
		name: deploymentName,
		template,
		parameters: bound,
		resources: [],
		outputs: {},
		errors: [],
	};
	const raw = template.resources ?? {};
	const entries: [string, RawResource][] = Array.isArray(raw)
		? raw.map((r, i) => [String(i), r])
		: Object.entries(raw);
	for (const [symbol, resource] of entries) {
		if (resource.existing === true) continue;
		const evaluator = new Evaluator(scope);
		let count = 1;
		if (resource.copy) {
			try {
				count = Number(evaluator.value(resource.copy.count));
			} catch (error) {
				// No resource is made to carry it, so the deployment does.
				deployment.errors.push(
					`${symbol}: the copy count: ${error instanceof Error ? error.message : String(error)}`,
				);
				count = 0;
			}
			if (!Number.isFinite(count) || count > 64) count = 0;
		}
		for (let i = 0; i < count; i++) {
			const indexed = resource.copy
				? new Evaluator({
						...scope,
						copyIndex: { [resource.copy.name]: i, "": i },
					})
				: evaluator;
			deployment.resources.push(
				evaluateResource(
					symbol,
					resource,
					indexed,
					resource.copy ? i : undefined,
				),
			);
		}
	}
	for (const [name, output] of Object.entries(template.outputs ?? {})) {
		try {
			deployment.outputs[name] = new Evaluator(scope).value(output.value);
		} catch (error) {
			deployment.outputs[name] = undefined;
			deployment.errors.push(
				`output ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return deployment;
}

function evaluateResource(
	symbol: string,
	raw: RawResource,
	evaluator: Evaluator,
	copyIndex?: number,
): Resource {
	const resource: Resource = {
		symbol,
		type: raw.type,
		name: null,
		condition: true,
		properties: null,
		tags: null,
		dependsOn: (raw.dependsOn as string[] | undefined) ?? [],
		copyIndex,
	};
	try {
		resource.condition =
			raw.condition === undefined
				? true
				: truthy(evaluator.value(raw.condition));
		if (!resource.condition) return resource;
		resource.name = evaluator.value(raw.name);
		resource.tags = evaluator.value(raw.tags ?? null);
		if (raw.scope !== undefined) resource.scope = evaluator.value(raw.scope);
		if (raw.zones !== undefined) resource.zones = evaluator.value(raw.zones);
		if (raw.type === "Microsoft.Resources/deployments") {
			const properties = raw.properties ?? {};
			const inner = properties.template as Template | undefined;
			if (inner) {
				const passed: Record<string, unknown> = {};
				// A conditional argument compiles to an expression around the whole `{ value }` entry.
				for (const [k, v] of Object.entries(
					(properties.parameters as Record<string, unknown>) ?? {},
				)) {
					const entry = evaluator.value(v) as { value?: unknown } | null;
					passed[k] = entry?.value ?? null;
				}
				resource.properties = { parameters: passed };
				resource.deployment = instantiate(
					inner,
					passed,
					stringOf(resource.name),
				);
			}
		} else resource.properties = evaluator.value(raw.properties ?? null);
	} catch (error) {
		resource.error = error instanceof Error ? error.message : String(error);
	}
	return resource;
}

// --- queries --------------------------------------------------------------

/** Every resource in the tree, depth first, with the chain of deployment names above it. */
export function allResources(
	deployment: Deployment,
	path: string[] = [],
): (Resource & { path: string[] })[] {
	const out: (Resource & { path: string[] })[] = [];
	for (const r of deployment.resources) {
		out.push({ ...r, path });
		if (r.deployment)
			out.push(...allResources(r.deployment, [...path, r.deployment.name]));
	}
	return out;
}

/**
 * Everything in the tree that an evaluation refused, each with where: a
 * resource's own expression, a copy loop's count, an output. A deployment
 * that is not made (a false condition) is not looked into.
 */
export function allErrors(
	deployment: Deployment,
	path: string[] = [],
): string[] {
	const at = (what: string) => [...path, what].join("/");
	const out = deployment.errors.map(at);
	for (const r of deployment.resources) {
		if (r.error) out.push(`${at(r.symbol)}: ${r.error}`);
		if (r.deployment && r.condition)
			out.push(...allErrors(r.deployment, [...path, r.deployment.name]));
	}
	return out;
}

export type ModuleCall = {
	path: string[];
	/** The one resource type the module exists to create. */
	mainType: string;
	parameters: Record<string, unknown>;
	deployment: Deployment;
};

/** The nested deployments that are Azure Verified Module calls, by the main resource type each creates. */
export function moduleCalls(deployment: Deployment): ModuleCall[] {
	return allResources(deployment)
		.filter(
			(r) =>
				r.deployment && r.condition && r.deployment.template.metadata?.name,
		)
		.map((r) => {
			const d = r.deployment as Deployment;
			const raw = d.template.resources ?? {};
			const types = (Array.isArray(raw) ? raw : Object.values(raw))
				.filter((x) => x.existing !== true)
				.map((x) => x.type)
				.filter(
					(t) =>
						t !== "Microsoft.Resources/deployments" &&
						t.split("/").length === 2,
				);
			return {
				path: [...r.path, d.name],
				mainType: types[0] ?? "",
				parameters: (r.properties as { parameters: Record<string, unknown> })
					.parameters,
				deployment: d,
			};
		})
		.filter((m) => m.mainType !== "");
}

export function sampleDeployment(
	overrides: Record<string, unknown> = {},
): Deployment | null {
	const template = compiledMain();
	return template ? instantiate(template, sampleParameters(overrides)) : null;
}
