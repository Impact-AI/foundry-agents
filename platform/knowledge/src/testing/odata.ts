/**
 * The slice of OData `$filter` this package writes, evaluated as the service
 * evaluates it, for the index stand-in: `and`, `or`, `not`, parentheses,
 * comparisons against a string, a boolean, `null` or a number, a bare
 * boolean field, `search.in(field, 'a|b', '|')`, and `any` over a
 * collection with either of those inside. Anything else throws, so a filter
 * the stand-in cannot read fails a test rather than passing it.
 *
 * Three-valued as the service is: a comparison with an absent field is
 * false unless it asks for `null`, which is why `injection eq false` never
 * admits a chunk Prompt Shields has not read.
 */

type Token =
	| { t: "ident"; v: string }
	| { t: "string"; v: string }
	| { t: "number"; v: number }
	| { t: "punct"; v: string };

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i] as string;
		if (/\s/.test(c)) {
			i++;
		} else if (c === "'") {
			let v = "";
			i++;
			for (;;) {
				if (i >= src.length) throw new Error(`unterminated string in ${src}`);
				if (src[i] === "'") {
					if (src[i + 1] === "'") {
						v += "'";
						i += 2;
						continue;
					}
					i++;
					break;
				}
				v += src[i];
				i++;
			}
			out.push({ t: "string", v });
		} else if ("(),:/".includes(c)) {
			out.push({ t: "punct", v: c });
			i++;
		} else if (/[0-9-]/.test(c)) {
			const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
			if (!m) throw new Error(`unreadable number in ${src}`);
			out.push({ t: "number", v: Number(m[0]) });
			i += m[0].length;
		} else if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_][\w.]*/.exec(src.slice(i)) as RegExpExecArray;
			out.push({ t: "ident", v: m[0] });
			i += m[0].length;
		} else throw new Error(`the stand-in cannot read "${c}" in ${src}`);
	}
	return out;
}

type Doc = Record<string, unknown>;
type Pred = (doc: Doc, scope: Record<string, unknown>) => boolean;

const COMPARE: Record<string, (a: unknown, b: unknown) => boolean> = {
	eq: (a, b) => (a ?? null) === b,
	ne: (a, b) => (a ?? null) !== b,
	gt: (a, b) => a != null && b != null && (a as string) > (b as string),
	ge: (a, b) => a != null && b != null && (a as string) >= (b as string),
	lt: (a, b) => a != null && b != null && (a as string) < (b as string),
	le: (a, b) => a != null && b != null && (a as string) <= (b as string),
};

class Parser {
	private i = 0;
	constructor(
		private readonly tokens: Token[],
		private readonly src: string,
	) {}

	parse(): Pred {
		const pred = this.or();
		if (this.i < this.tokens.length)
			throw new Error(
				`the stand-in cannot read past token ${this.i} of ${this.src}`,
			);
		return pred;
	}

	private peek(): Token | undefined {
		return this.tokens[this.i];
	}

	private next(): Token {
		const token = this.tokens[this.i++];
		if (!token) throw new Error(`unexpected end of ${this.src}`);
		return token;
	}

	private punct(v: string): void {
		const token = this.next();
		if (token.t !== "punct" || token.v !== v)
			throw new Error(`expected "${v}" in ${this.src}`);
	}

	private keyword(v: string): boolean {
		const token = this.peek();
		if (token?.t === "ident" && token.v === v) {
			this.i++;
			return true;
		}
		return false;
	}

	private or(): Pred {
		const parts = [this.and()];
		while (this.keyword("or")) parts.push(this.and());
		return (d, s) => parts.some((p) => p(d, s));
	}

	private and(): Pred {
		const parts = [this.unary()];
		while (this.keyword("and")) parts.push(this.unary());
		return (d, s) => parts.every((p) => p(d, s));
	}

	private unary(): Pred {
		if (this.keyword("not")) {
			const inner = this.unary();
			return (d, s) => !inner(d, s);
		}
		return this.primary();
	}

	private literal(): unknown {
		const token = this.next();
		if (token.t === "string" || token.t === "number") return token.v;
		if (token.t === "ident" && token.v === "true") return true;
		if (token.t === "ident" && token.v === "false") return false;
		if (token.t === "ident" && token.v === "null") return null;
		throw new Error(`expected a literal in ${this.src}`);
	}

	/** A field of the document, or the lambda's variable. */
	private value(name: string): (d: Doc, s: Record<string, unknown>) => unknown {
		return (d, s) => (name in s ? s[name] : d[name]);
	}

	private primary(): Pred {
		const token = this.next();
		if (token.t === "punct" && token.v === "(") {
			const inner = this.or();
			this.punct(")");
			return inner;
		}
		if (token.t !== "ident")
			throw new Error(
				`the stand-in cannot read ${JSON.stringify(token)} in ${this.src}`,
			);
		if (token.v === "search.in") {
			this.punct("(");
			const field = this.next();
			if (field.t !== "ident")
				throw new Error(`search.in needs a field in ${this.src}`);
			this.punct(",");
			const list = this.literal() as string;
			let delimiter = ",";
			if (this.peek()?.v === ",") {
				this.next();
				delimiter = this.literal() as string;
			}
			this.punct(")");
			const values = new Set(list.split(delimiter).map((v) => v.trim()));
			const read = this.value(field.v);
			return (d, s) => values.has(read(d, s) as string);
		}
		if (this.peek()?.t === "punct" && this.peek()?.v === "/") {
			this.next();
			const any = this.next();
			if (any.t !== "ident" || any.v !== "any")
				throw new Error(`the stand-in reads only any() in ${this.src}`);
			this.punct("(");
			const variable = this.next();
			if (variable.t !== "ident")
				throw new Error(`any() needs a variable in ${this.src}`);
			this.punct(":");
			const body = this.or();
			this.punct(")");
			const collection = this.value(token.v);
			return (d, s) => {
				const items = collection(d, s);
				return (
					Array.isArray(items) &&
					items.some((item) => body(d, { ...s, [variable.v]: item }))
				);
			};
		}
		const op = this.peek();
		if (op?.t === "ident" && op.v in COMPARE) {
			this.next();
			const compare = COMPARE[op.v] as (a: unknown, b: unknown) => boolean;
			const right = this.literal();
			const read = this.value(token.v);
			return (d, s) => compare(read(d, s), right);
		}
		const read = this.value(token.v);
		return (d, s) => read(d, s) === true;
	}
}

/** The filter as a predicate over a document; throws on what the stand-in cannot read. */
export function compileFilter(
	filter: string | undefined,
): (doc: Doc) => boolean {
	if (!filter?.trim()) return () => true;
	const pred = new Parser(tokenize(filter), filter).parse();
	return (doc) => pred(doc, {});
}
