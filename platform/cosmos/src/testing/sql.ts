/**
 * The small part of Cosmos DB's SQL the stores write, parsed and evaluated
 * as the service does, for the in-memory stand-in: `SELECT [TOP n] * FROM c
 * [WHERE …] [ORDER BY …] [OFFSET n LIMIT m]`, and a patch's condition, `FROM
 * c WHERE …`. A predicate is three-valued as the service's is: a missing
 * field, or two values of different types, compare to undefined, and a
 * document is kept only where the predicate is true. Anything outside the
 * subset throws, so a store that writes a query the stand-in cannot answer
 * fails in its own tests rather than answering differently from the service.
 */

type Value = unknown;
type Parameters = ReadonlyMap<string, Value>;

type Expr =
	| { kind: "literal"; value: Value }
	| { kind: "param"; name: string }
	| { kind: "path"; root: string; segments: string[] }
	| { kind: "not"; operand: Expr }
	| { kind: "and" | "or"; left: Expr; right: Expr }
	| { kind: "compare"; op: Comparison; left: Expr; right: Expr }
	| { kind: "call"; name: keyof typeof FUNCTIONS; argument: Expr };

type Comparison = "=" | "!=" | "<" | "<=" | ">" | ">=";

const FUNCTIONS = {
	IS_DEFINED: (value: Value) => value !== undefined,
	IS_NULL: (value: Value) => value === null,
};

export interface ParsedQuery {
	alias: string;
	where?: Expr;
	orderBy: { path: Expr; descending: boolean }[];
	top?: Expr;
	offset?: Expr;
	limit?: Expr;
}

/* ---- tokens ---- */

interface Token {
	type: "word" | "number" | "string" | "param" | "symbol" | "end";
	text: string;
	value?: Value;
}

const SYMBOLS = [
	"<=",
	">=",
	"!=",
	"<>",
	"=",
	"<",
	">",
	"(",
	")",
	",",
	".",
	"*",
	"[",
	"]",
];

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i);
		const space = /^\s+/.exec(rest);
		if (space) {
			i += space[0].length;
			continue;
		}
		const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
		const number = /^-?\d+(\.\d+)?/.exec(rest);
		const param = /^@[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
		const quoted = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(rest);
		const symbol = SYMBOLS.find((s) => rest.startsWith(s));
		if (word) tokens.push({ type: "word", text: word[0] });
		else if (number)
			tokens.push({
				type: "number",
				text: number[0],
				value: Number(number[0]),
			});
		else if (param) tokens.push({ type: "param", text: param[0] });
		else if (quoted)
			tokens.push({
				type: "string",
				text: quoted[0],
				value: (quoted[2] as string).replace(/\\(.)/g, "$1"),
			});
		else if (symbol) tokens.push({ type: "symbol", text: symbol });
		else throw new Error(`the stand-in cannot read "${rest.slice(0, 20)}"`);
		i += (word ?? number ?? param ?? quoted)?.[0].length ?? symbol?.length ?? 1;
	}
	tokens.push({ type: "end", text: "" });
	return tokens;
}

/* ---- parsing ---- */

class Parser {
	private at = 0;
	constructor(
		private readonly tokens: Token[],
		private readonly source: string,
	) {}

	private peek(): Token {
		return this.tokens[this.at] as Token;
	}

	private next(): Token {
		return this.tokens[this.at++] as Token;
	}

	isKeyword(...words: string[]): boolean {
		const token = this.peek();
		return token.type === "word" && words.includes(token.text.toUpperCase());
	}

	isSymbol(symbol: string): boolean {
		const token = this.peek();
		return token.type === "symbol" && token.text === symbol;
	}

	fail(what: string): never {
		throw new Error(
			`the stand-in's SQL has no ${what} at "${this.peek().text}" in: ${this.source}`,
		);
	}

	keyword(word: string): void {
		if (!this.isKeyword(word)) this.fail(word);
		this.next();
	}

	symbol(symbol: string): void {
		if (!this.isSymbol(symbol)) this.fail(`"${symbol}"`);
		this.next();
	}

	identifier(): string {
		const token = this.next();
		if (token.type !== "word") this.fail("identifier");
		return token.text;
	}

	end(): void {
		if (this.peek().type !== "end") this.fail("end of query");
	}

	expression(): Expr {
		let left = this.conjunction();
		while (this.isKeyword("OR")) {
			this.next();
			left = { kind: "or", left, right: this.conjunction() };
		}
		return left;
	}

	private conjunction(): Expr {
		let left = this.negation();
		while (this.isKeyword("AND")) {
			this.next();
			left = { kind: "and", left, right: this.negation() };
		}
		return left;
	}

	private negation(): Expr {
		if (this.isKeyword("NOT")) {
			this.next();
			return { kind: "not", operand: this.negation() };
		}
		return this.comparison();
	}

	private comparison(): Expr {
		const left = this.operand();
		const token = this.peek();
		if (token.type !== "symbol" || !/^(=|!=|<>|<|<=|>|>=)$/.test(token.text))
			return left;
		this.next();
		const op = (token.text === "<>" ? "!=" : token.text) as Comparison;
		return { kind: "compare", op, left, right: this.operand() };
	}

	operand(): Expr {
		const token = this.next();
		if (token.type === "symbol" && token.text === "(") {
			const inner = this.expression();
			this.symbol(")");
			return inner;
		}
		if (token.type === "number" || token.type === "string")
			return { kind: "literal", value: token.value };
		if (token.type === "param") return { kind: "param", name: token.text };
		if (token.type !== "word") this.fail("operand");
		const upper = token.text.toUpperCase();
		if (upper === "TRUE") return { kind: "literal", value: true };
		if (upper === "FALSE") return { kind: "literal", value: false };
		if (upper === "NULL") return { kind: "literal", value: null };
		if (upper in FUNCTIONS) {
			this.symbol("(");
			const argument = this.expression();
			this.symbol(")");
			return { kind: "call", name: upper as keyof typeof FUNCTIONS, argument };
		}
		const segments: string[] = [];
		for (;;) {
			if (this.isSymbol(".")) {
				this.next();
				segments.push(this.identifier());
			} else if (this.isSymbol("[")) {
				this.next();
				const key = this.next();
				if (key.type !== "string") this.fail("quoted property name");
				segments.push(key.value as string);
				this.symbol("]");
			} else break;
		}
		return { kind: "path", root: token.text, segments };
	}

	/** A count: a number or a parameter. */
	count(): Expr {
		const token = this.peek();
		if (token.type !== "number" && token.type !== "param") this.fail("count");
		return this.operand();
	}
}

export function parseQuery(text: string): ParsedQuery {
	const p = new Parser(tokenize(text), text);
	p.keyword("SELECT");
	let top: Expr | undefined;
	if (p.isKeyword("TOP")) {
		p.keyword("TOP");
		top = p.count();
	}
	p.symbol("*");
	p.keyword("FROM");
	const alias = p.identifier();
	let where: Expr | undefined;
	if (p.isKeyword("WHERE")) {
		p.keyword("WHERE");
		where = p.expression();
	}
	const orderBy: ParsedQuery["orderBy"] = [];
	if (p.isKeyword("ORDER")) {
		p.keyword("ORDER");
		p.keyword("BY");
		for (;;) {
			const path = p.operand();
			if (path.kind !== "path") p.fail("property to order by");
			const descending = p.isKeyword("DESC");
			if (p.isKeyword("ASC", "DESC")) p.identifier();
			orderBy.push({ path, descending });
			if (!p.isSymbol(",")) break;
			p.symbol(",");
		}
	}
	let offset: Expr | undefined;
	let limit: Expr | undefined;
	if (p.isKeyword("OFFSET")) {
		p.keyword("OFFSET");
		offset = p.count();
		p.keyword("LIMIT");
		limit = p.count();
	}
	p.end();
	return { alias, where, orderBy, top, offset, limit };
}

/** A patch's condition, `FROM c WHERE …`. */
export function parseCondition(text: string): { alias: string; where: Expr } {
	const p = new Parser(tokenize(text), text);
	p.keyword("FROM");
	const alias = p.identifier();
	p.keyword("WHERE");
	const where = p.expression();
	p.end();
	return { alias, where };
}

/* ---- evaluation ---- */

function sameType(a: Value, b: Value): boolean {
	if (a === null || b === null) return a === b;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	return typeof a === typeof b;
}

function compare(op: Comparison, a: Value, b: Value): boolean | undefined {
	if (a === undefined || b === undefined || !sameType(a, b)) return undefined;
	if (op === "=") return Bun.deepEquals(a, b, true);
	if (op === "!=") return !Bun.deepEquals(a, b, true);
	if (typeof a !== "number" && typeof a !== "string") return undefined;
	const order = a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
	return op === "<"
		? order < 0
		: op === "<="
			? order <= 0
			: op === ">"
				? order > 0
				: order >= 0;
}

export function evaluate(
	expr: Expr,
	alias: string,
	document: Record<string, unknown>,
	parameters: Parameters,
): Value {
	const recur = (e: Expr) => evaluate(e, alias, document, parameters);
	switch (expr.kind) {
		case "literal":
			return expr.value;
		case "param":
			if (!parameters.has(expr.name))
				throw new Error(`no value for the parameter ${expr.name}`);
			return parameters.get(expr.name);
		case "path": {
			if (expr.root !== alias)
				throw new Error(`"${expr.root}" is not the query's alias "${alias}"`);
			let value: Value = document;
			for (const segment of expr.segments)
				value =
					value !== null && typeof value === "object" && !Array.isArray(value)
						? (value as Record<string, unknown>)[segment]
						: undefined;
			return value;
		}
		case "not": {
			const value = recur(expr.operand);
			return typeof value === "boolean" ? !value : undefined;
		}
		case "and": {
			const [l, r] = [recur(expr.left), recur(expr.right)];
			if (l === false || r === false) return false;
			return l === true && r === true ? true : undefined;
		}
		case "or": {
			const [l, r] = [recur(expr.left), recur(expr.right)];
			if (l === true || r === true) return true;
			return l === false && r === false ? false : undefined;
		}
		case "compare":
			return compare(expr.op, recur(expr.left), recur(expr.right));
		case "call":
			return FUNCTIONS[expr.name](recur(expr.argument));
	}
}

/** The service's order across types: undefined, null, booleans, numbers, strings, arrays, objects. */
function rank(value: Value): number {
	if (value === undefined) return 0;
	if (value === null) return 1;
	if (typeof value === "boolean") return 2;
	if (typeof value === "number") return 3;
	if (typeof value === "string") return 4;
	return Array.isArray(value) ? 5 : 6;
}

function ordered(a: Value, b: Value): number {
	const byRank = rank(a) - rank(b);
	if (byRank !== 0) return byRank;
	if (typeof a === "number" || typeof a === "string" || typeof a === "boolean")
		return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
	return 0;
}

function countOf(
	expr: Expr | undefined,
	parameters: Parameters,
): number | undefined {
	if (!expr) return undefined;
	const value = evaluate(expr, "", {}, parameters);
	if (!Number.isInteger(value) || (value as number) < 0)
		throw new Error(
			`a count must be a non-negative integer, not ${String(value)}`,
		);
	return value as number;
}

/** The documents `query` answers, in its order. */
export function runQuery<T extends Record<string, unknown>>(
	query: ParsedQuery,
	documents: readonly T[],
	parameters: Parameters,
): T[] {
	const { alias, where } = query;
	let rows = where
		? documents.filter((d) => evaluate(where, alias, d, parameters) === true)
		: [...documents];
	if (query.orderBy.length > 0)
		rows.sort((a, b) => {
			for (const { path, descending } of query.orderBy) {
				const order = ordered(
					evaluate(path, alias, a, parameters),
					evaluate(path, alias, b, parameters),
				);
				if (order !== 0) return descending ? -order : order;
			}
			return 0;
		});
	const offset = countOf(query.offset, parameters) ?? 0;
	const limit =
		countOf(query.limit, parameters) ?? countOf(query.top, parameters);
	rows = rows.slice(offset, limit === undefined ? undefined : offset + limit);
	return rows;
}
