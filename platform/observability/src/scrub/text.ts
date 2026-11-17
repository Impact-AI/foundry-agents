import { redactPath } from "./path";
import { scrubUrl } from "./query";

/**
 * Free text as it may be recorded: an error's message, a stack, a span name
 * some instrumentation built out of a URL.
 *
 * Prose cannot be made safe the way an attribute can, since nothing says
 * which word of a sentence is a name. What is taken out is what can be told
 * for what it is, and the text is read once, left to right: at each place a
 * rule could begin it either takes what it recognises or leaves the place to
 * the next character. A rule that takes nothing has looked no further than a
 * bound of its own (the constants named `…_MAX` below), or has left a note
 * (`Reading`) that keeps the next place from looking over the same stretch
 * again, so no stretch of the text is read more than a fixed number of
 * times. `SCANNED_MAX` holds the text itself to a size.
 *
 *   - a URL of any network scheme is put through the URL scrub, so its
 *     userinfo and its query go and its value-shaped path segments collapse;
 *   - a request path, known by the query it carries or the HTTP method before
 *     it, gets the same;
 *   - a pair whose key names a credential keeps the key and loses the value,
 *     written `key=value`, `key: value` or as JSON, the value bare or quoted;
 *   - `Authorization`, `Cookie` and `Set-Cookie` lose the rest of their line;
 *   - a `Bearer` or `Basic` credential, a signed token and an address are
 *     replaced by what they were.
 *
 * Everything else is left, because a message that no longer says what failed
 * diagnoses nothing: a file path in a stack frame is not a request path,
 * `package@version` is not an address, and "Basic usage" is not a credential.
 * What no rule here can tell is left too, and the package's README states it.
 */

const REDACTED = "[redacted]";

/** What stands for the rest of a text longer than may be read. */
const TRUNCATED = " [truncated]";

/**
 * The most of a text that is read and recorded, in UTF-16 units. A stack runs
 * to a few thousand; past this it is a payload somebody put in a message.
 */
const SCANNED_MAX = 65_536;

/** A replacement for `text.slice(start, end)`. */
interface Found {
	start: number;
	end: number;
	text: string;
}

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const DQUOTE = 34;
const SQUOTE = 39;
const AT = 64;
const BACKSLASH = 92;
const SLASH = 47;

const isLetter = (c: number): boolean =>
	(c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
/** A letter, a digit or `_`: what a word is made of. */
const isWord = (c: number): boolean => isLetter(c) || isDigit(c) || c === 95;
/** A key's name: a word's characters and `-`. */
const isName = (c: number): boolean => isWord(c) || c === 45;
const isBlank = (c: number): boolean => c === SPACE || c === TAB;
const isSpace = (c: number): boolean =>
	c === SPACE || (c >= TAB && c <= CR) || c === 0xa0;
const isQuote = (c: number): boolean => c === DQUOTE || c === SQUOTE;
/** `+`, `-`, `.` and a word's characters less `_`: a URL's scheme. */
const isScheme = (c: number): boolean =>
	isLetter(c) || isDigit(c) || c === 43 || c === 45 || c === 46;
/** An address's name before the `@`. */
const isLocal = (c: number): boolean =>
	isWord(c) || c === 46 || c === 37 || c === 43 || c === 45;
const isDomain = (c: number): boolean =>
	isLetter(c) || isDigit(c) || c === 46 || c === 45;
/** Where a value written in prose stops: whitespace, a quote, `<`, `>`, `)` or `]`. */
const endsValue = (c: number): boolean =>
	isSpace(c) || isQuote(c) || c === 60 || c === 62 || c === 41 || c === 93;
/** Where a bare value of a pair stops: the above, and what separates one pair from the next. */
const endsBare = (c: number): boolean =>
	endsValue(c) || c === 38 || c === 59 || c === 44 || c === 125;
/** Punctuation that closes a sentence or a clause, never a URL, a path or a value. */
const isClosing = (c: number): boolean =>
	c === 46 || c === 44 || c === 58 || c === 59 || c === 33 || c === 63;

/**
 * What one reading has already learned about the text ahead, so that a place
 * further on does not learn it again.
 */
interface Reading {
	/** A signed token was looked for up to here and is not there: no place before it begins one. */
	noTokenBefore: number;
	/** The line whose end is known: from `lineFrom` it ends at `lineTo`. */
	lineFrom: number;
	lineTo: number;
	/** Up to here the line is a `curl` command's, whose `-u` is a credential. */
	curlUntil: number;
	/**
	 * An authority known: from `authorityFrom` it runs to `authorityTo` (its
	 * first `/`, `?`, `#` or whitespace), and its last `@` is at
	 * `authorityLastAt` (-1 when it holds none).
	 */
	authorityFrom: number;
	authorityTo: number;
	authorityLastAt: number;
	/** A name known: from `nameFrom` its letters, digits, `_` and `-` run to `nameTo`. */
	nameFrom: number;
	nameTo: number;
}

/**
 * Where the name that `from` is in ends. Every word of one long name shares
 * its end, so `a-b-c-…` is walked once however many words it holds.
 */
function nameRun(text: string, from: number, reading: Reading): number {
	if (from >= reading.nameFrom && from <= reading.nameTo) return reading.nameTo;
	let to = from;
	while (to < text.length && isName(text.charCodeAt(to))) to++;
	reading.nameFrom = from;
	reading.nameTo = to;
	return to;
}

/** The end of the line `from` is on: its line break, or the text's end. Each line is walked once. */
function lineEnd(text: string, from: number, reading: Reading): number {
	if (from >= reading.lineFrom && from <= reading.lineTo) return reading.lineTo;
	let end = from;
	while (end < text.length) {
		const c = text.charCodeAt(end);
		if (c === LF || c === CR) break;
		end++;
	}
	reading.lineFrom = from;
	reading.lineTo = end;
	return end;
}

/**
 * Where the authority that `from` is in ends, and its last `@`. Every place
 * inside one stretch shares its end, so the stretch is walked once whatever
 * number of `://` stand in it.
 */
function authority(
	text: string,
	from: number,
	reading: Reading,
): { to: number; lastAt: number } {
	if (from < reading.authorityFrom || from > reading.authorityTo) {
		let to = from;
		let lastAt = -1;
		while (to < text.length) {
			const c = text.charCodeAt(to);
			if (isSpace(c) || c === SLASH || c === 63 || c === 35) break;
			if (c === AT) lastAt = to;
			to++;
		}
		reading.authorityFrom = from;
		reading.authorityTo = to;
		reading.authorityLastAt = lastAt;
	}
	return {
		to: reading.authorityTo,
		lastAt: reading.authorityLastAt >= from ? reading.authorityLastAt : -1,
	};
}

/** `end` moved back over the punctuation that closes a sentence. */
function beforeClosing(text: string, start: number, end: number): number {
	let stop = end;
	while (stop > start && isClosing(text.charCodeAt(stop - 1))) stop--;
	return stop;
}

/**
 * Schemes that name a place in the code, not on the network: what follows is
 * a file and a position, which a stack frame is for.
 */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set([
	"file",
	"node",
	"bun",
	"webpack",
	"webpack-internal",
	"turbopack",
	"rsc",
	"app",
]);

const SCHEME_MAX = 32;

/** What closes what a value was opened by: the quote itself, or the bracket's partner. */
function closerOf(opener: number): number {
	if (isQuote(opener)) return opener;
	if (opener === 60) return 62;
	return 0;
}

/** A quote or a closing bracket: what a URL written in prose or in code is closed by. */
const isCloser = (c: number): boolean =>
	isQuote(c) || c === 62 || c === 41 || c === 93 || c === 125;

/**
 * Where a query that began at `from` ends: at whitespace, or at a quote or a
 * closing bracket after which, past any more of them and any sentence's
 * punctuation, comes whitespace or the text's end. A run of those followed by
 * anything else is the value's, since a secret may hold a quote, a bracket
 * and a full stop: `?token=ab".Zq9` keeps going to its `9`. The run is passed
 * over either way, so it is read once.
 */
function queryEnd(text: string, from: number): number {
	const n = text.length;
	let end = from;
	while (end < n) {
		const c = text.charCodeAt(end);
		if (isSpace(c)) break;
		if (isCloser(c) || c === 60) {
			let run = end + 1;
			while (run < n) {
				const r = text.charCodeAt(run);
				if (!(isCloser(r) || r === 60 || isClosing(r))) break;
				run++;
			}
			if (run >= n || isSpace(text.charCodeAt(run))) break;
			end = run;
			continue;
		}
		end++;
	}
	return end;
}

/**
 * `scheme://…` at `start`, the scheme ending at `schemeEnd`. The userinfo
 * runs to the last `@` before the authority's first `/`, `?` or `#`,
 * whatever it holds, since a password may hold a quote or a bracket; the
 * host after it ends as a value in prose does, and at a `;`, which ends a
 * connection string's part. A query runs to whitespace or to what closes the
 * thing the URL stands inside (`queryEnd`).
 *
 * A scheme that names a place in the code keeps its path as written: only a
 * userinfo is taken out, and what follows is read on by the other rules.
 */
function url(
	text: string,
	start: number,
	schemeEnd: number,
	reading: Reading,
): Found {
	const n = text.length;
	const opens = schemeEnd + 3;
	// The userinfo is everything to the authority's last `@`, however long:
	// a password is never left in part.
	const { lastAt } = authority(text, opens, reading);
	const host = lastAt >= 0 ? lastAt + 1 : opens;
	const scheme = text.slice(start, opens);
	if (LOCAL_SCHEMES.has(text.slice(start, schemeEnd).toLowerCase()))
		return { start, end: host, text: scheme };
	let bracketed = false;
	let p = host;
	for (; p < n; p++) {
		const c = text.charCodeAt(p);
		if (isSpace(c) || isQuote(c) || c === 60 || c === 62) break;
		if (c === SLASH || c === 63 || c === 35 || c === 59) break;
		if (c === 41 || (c === 93 && !bracketed)) break;
		if (c === 91) bracketed = true;
	}
	let end = p;
	// The path, as a value in prose ends; then the query and the fragment.
	while (end < n) {
		const c = text.charCodeAt(end);
		if (endsValue(c) || c === 59 || c === 63 || c === 35) break;
		end++;
	}
	const marked = text.charCodeAt(end);
	if (marked === 63 || marked === 35) end = queryEnd(text, end + 1);
	const stop = beforeClosing(text, host, end);
	return {
		start,
		end,
		text: `${scrubUrl(`${scheme}${text.slice(host, stop)}`) || "[url]"}${text.slice(stop, end)}`,
	};
}

/**
 * A path with a query, from the `?` at `mark` to where the query ends. A `?`
 * with nothing after it closes a question and opens no query.
 */
function pathAndQuery(text: string, start: number, mark: number): Found | null {
	const end = queryEnd(text, mark + 1);
	const stop = beforeClosing(text, mark + 1, end);
	if (stop === mark + 1) return null;
	return {
		start,
		end,
		text: `${scrubUrl(text.slice(start, stop)) || "[url]"}${text.slice(stop, end)}`,
	};
}

/** Where a path that began at `start` stops: a query, a fragment or the end of a value. */
function pathEnd(text: string, start: number): number {
	let end = start;
	while (end < text.length) {
		const c = text.charCodeAt(end);
		if (endsValue(c) || c === 63 || c === 35) break;
		end++;
	}
	return end;
}

const METHODS: ReadonlySet<string> = new Set([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
]);

/** The path a request line names: the method says it is one, where a bare path could be a file. */
function requestLine(text: string, nameEnd: number): Found | null {
	let start = nameEnd;
	while (start < text.length && isBlank(text.charCodeAt(start))) start++;
	if (start === nameEnd || text.charCodeAt(start) !== SLASH) return null;
	const end = pathEnd(text, start);
	if (text.charCodeAt(end) === 63) {
		const queried = pathAndQuery(text, start, end);
		if (queried) return queried;
	}
	const stop = beforeClosing(text, start + 1, end);
	return {
		start,
		end,
		text: `${redactPath(text.slice(start, stop))}${text.slice(stop, end)}`,
	};
}

/** The most of one part of a signed token that is read. */
const TOKEN_PART_MAX = 16_384;

/**
 * A signed token: `eyJ…` and two more parts of at least eight characters,
 * and any after them. A first part that led to no token leads to none from
 * any place inside it either, which `noTokenBefore` remembers.
 */
function signedToken(
	text: string,
	start: number,
	reading: Reading,
): Found | null {
	if (start < reading.noTokenBefore) return null;
	const part = (from: number): number => {
		const limit = Math.min(text.length, from + TOKEN_PART_MAX);
		let end = from;
		while (end < limit) {
			const c = text.charCodeAt(end);
			if (!isWord(c) && c !== 45) break;
			end++;
		}
		return end;
	};
	const first = part(start);
	if (first - start < 11) return null;
	let end = first;
	let parts = 1;
	while (text.charCodeAt(end) === 46) {
		const next = part(end + 1);
		if (parts < 3 && next - end - 1 < 8) break;
		if (next === end + 1) break;
		end = next;
		parts++;
	}
	if (parts >= 3) return { start, end, text: "[token]" };
	reading.noTokenBefore = first;
	return null;
}

const LOCAL_MAX = 64;
const DOMAIN_MAX = 255;
/** How far past `user@host:` is read to tell a path, which makes it a remote and not an address. */
const REMOTE_PATH_MAX = 128;

/**
 * An address around the `@` at `at`: a name, and a host whose last label is
 * letters and which does not open as a version does, with two numbers. Those
 * are what tell it from `package@1.2.3` and `package@1.2.3-rc.next` in a
 * stack frame, while `name@163.com` is still an address; a path after
 * `host:` is what tells `git@host:org/repo` from one.
 */
function address(text: string, at: number, floor: number): Found | null {
	let start = at;
	while (
		start > floor &&
		at - start < LOCAL_MAX &&
		isLocal(text.charCodeAt(start - 1))
	)
		start--;
	if (start === at) return null;
	const from = at + 1;
	let run = from;
	while (
		run < text.length &&
		run - from < DOMAIN_MAX &&
		isDomain(text.charCodeAt(run))
	)
		run++;
	if (run < text.length && isName(text.charCodeAt(run))) return null;
	let end = run;
	while (end > from) {
		const c = text.charCodeAt(end - 1);
		if (c !== 46 && c !== 45) break;
		end--;
	}
	const labels = text.slice(from, end).split(".");
	const first = labels[0] ?? "";
	const second = labels[1] ?? "";
	const last = labels[labels.length - 1] ?? "";
	if (labels.length < 2 || labels.some((label) => label === "")) return null;
	if (!/^[A-Za-z]{2,}$/.test(last)) return null;
	if (/^\d+$/.test(first) && /^\d/.test(second)) return null;
	if (end === run && text.charCodeAt(end) === 58) {
		let p = end + 1;
		const stop = Math.min(text.length, p + REMOTE_PATH_MAX);
		const opens = text.charCodeAt(p);
		let slash = opens === SLASH || opens === 126;
		for (; p < stop && !isSpace(text.charCodeAt(p)); p++)
			if (text.charCodeAt(p) === SLASH) slash = true;
		if (slash) return null;
	}
	return { start, end, text: "[email]" };
}

/** A value that reads as a credential rather than a word: not short, and not letters alone unless long. */
function shaped(token: string): boolean {
	return token.length >= 6 && (token.length >= 16 || /[^A-Za-z]/.test(token));
}

/**
 * What follows a bare `Bearer` or `Basic` when it is a credential and not the
 * next word of a sentence: eight characters or more that hold a digit, one of
 * `+`, `/`, `=`, or two capitals after small letters; or sixteen or more of
 * anything.
 */
function credentialShaped(token: string): boolean {
	if (token.length < 8) return false;
	if (token.length >= 16 || /[0-9+/=]/.test(token)) return true;
	return (token.match(/[a-z][A-Z]/g)?.length ?? 0) >= 2;
}

/** How far a value written inside `<…>` or after a bare scheme word in quotes is read for its close. */
const ENCLOSED_MAX = 512;

/** The value between the opener at `open` and its partner on the same line, within `ENCLOSED_MAX`; null when it is not closed there. */
function enclosed(text: string, open: number): Found | null {
	const closer = closerOf(text.charCodeAt(open));
	const limit = Math.min(text.length, open + 1 + ENCLOSED_MAX);
	for (let p = open + 1; p < limit; p++) {
		const c = text.charCodeAt(p);
		if (c === LF || c === CR) return null;
		if (c === closer)
			return p > open + 1 ? { start: open + 1, end: p, text: REDACTED } : null;
	}
	return null;
}

function schemeCredential(text: string, nameEnd: number): Found | null {
	let start = nameEnd;
	while (start < text.length && isBlank(text.charCodeAt(start))) start++;
	if (start === nameEnd || text.startsWith(REDACTED, start)) return null;
	const opens = text.charCodeAt(start);
	if (isQuote(opens) || opens === 60) {
		const inside = enclosed(text, start);
		if (!inside || text.startsWith(REDACTED, inside.start)) return null;
		return credentialShaped(text.slice(inside.start, inside.end))
			? inside
			: null;
	}
	let end = start;
	while (end < text.length) {
		const c = text.charCodeAt(end);
		if (endsValue(c) || c === 44 || c === 59) break;
		end++;
	}
	const stop = beforeClosing(text, start, end);
	if (!credentialShaped(text.slice(start, stop))) return null;
	return { start, end: stop, text: REDACTED };
}

/**
 * How a key's value is taken. `line`: the rest of the line, which is how a
 * header carrying a scheme and a credential, or every cookie of a request,
 * is written. `header`: one value, whatever it looks like. `pair`: one value,
 * and after a `:` only one that reads as a credential, since "password:
 * required" is a sentence. `signature`: a shared access signature's parts,
 * which are words of two letters anywhere else.
 */
type Kind = "line" | "header" | "pair" | "signature";

/** A shared access signature's parameters: the signature, and what dates and scopes it. */
const SIGNATURE_KEYS: ReadonlySet<string> = new Set([
	"sig",
	"se",
	"sv",
	"sp",
	"sr",
	"st",
]);

/**
 * What a credential's key ends in, hyphens and underscores aside and in any
 * case: `client_secret`, `AccountKey`, `x-api-key`, `_authToken` and
 * `refreshToken` are all found by their last word.
 */
const CREDENTIAL_STEMS: readonly string[] = [
	"token",
	"secret",
	"password",
	"passwd",
	"passphrase",
	"pwd",
	"accountkey",
	"accesskey",
	"instrumentationkey",
	"sharedaccesssignature",
	"privatekey",
];

function kindOf(name: string): Kind | null {
	const lower = name.toLowerCase();
	if (SIGNATURE_KEYS.has(lower)) return "signature";
	const flat = lower.replace(/[-_]/g, "");
	if (flat === "cookie" || flat === "setcookie") return "line";
	if (flat.endsWith("authorization")) return "line";
	if (flat.endsWith("apikey") || flat.endsWith("subscriptionkey"))
		return "header";
	return CREDENTIAL_STEMS.some((stem) => flat.endsWith(stem)) ? "pair" : null;
}

/** The most of a quoted value that is read for its closing quote. */
const QUOTED_MAX = 8_192;
/** The most of an array or an object under a key that is read for its close. */
const BRACKET_MAX = 8_192;
/** The most backslashes that may stand before a quote written inside strings inside strings. */
const ESCAPES_MAX = 15;

/** How many backslashes end at `before`, the place just before a quote. */
function escapesBefore(text: string, before: number): number {
	let count = 0;
	while (
		count < ESCAPES_MAX &&
		before - count >= 0 &&
		text.charCodeAt(before - count) === BACKSLASH
	)
		count++;
	return count;
}

/** How many backslashes begin at `from`. */
function escapesAt(text: string, from: number): number {
	let count = 0;
	while (count <= ESCAPES_MAX && text.charCodeAt(from + count) === BACKSLASH)
		count++;
	return count;
}

/**
 * The closing `quote` of a string that opened before `from`, written with
 * `escapes` backslashes before each of its own quotes (none, for a string as
 * it stands; one or more for a string inside a string). The line's end, or
 * `QUOTED_MAX`, closes one that is never closed.
 */
function closingQuote(
	text: string,
	from: number,
	quote: number,
	escapes: number,
): number {
	const limit = Math.min(text.length, from + QUOTED_MAX);
	let p = from;
	while (p < limit) {
		const c = text.charCodeAt(p);
		if (c === LF || c === CR) break;
		if (c === BACKSLASH) {
			const run = escapesAt(text, p);
			const closes = text.charCodeAt(p + run) === quote;
			if (escapes > 0 && closes && run === escapes) break;
			// The backslashes, and the character an odd one takes with it.
			p += escapes === 0 ? 2 : run + (closes ? 1 : 0);
			continue;
		}
		if (escapes === 0 && c === quote) break;
		p++;
	}
	return Math.min(p, limit);
}

/** The end of the array or object that opens at `from`, strings read as strings, over as many lines as it takes within `BRACKET_MAX`. */
function closingBracket(text: string, from: number): number {
	const limit = Math.min(text.length, from + BRACKET_MAX);
	let depth = 0;
	let p = from;
	while (p < limit) {
		const c = text.charCodeAt(p);
		if (c === DQUOTE) {
			p = closingQuote(text, p + 1, DQUOTE, 0) + 1;
			continue;
		}
		if (c === 91 || c === 123) depth++;
		else if (c === 93 || c === 125) {
			depth--;
			if (depth === 0) return p + 1;
		}
		p++;
	}
	return Math.min(p, limit);
}

/** The most of a key's name that is read for the word that names a credential: its end. */
const NAME_MAX = 64;
/** How much whitespace may stand between a JSON key's `:` and its value. */
const GAP_MAX = 256;

/** One value at `p`: what stands in quotes or `<…>`, or what runs to whitespace, an unclosed quote with it. */
function oneValue(text: string, p: number): Found | null {
	const opens = text.charCodeAt(p);
	if (isQuote(opens) || opens === 60) {
		const inside = enclosed(text, p);
		// A quote never closed on its line: the word it opens goes with it.
		if (inside || !isQuote(opens)) return inside;
	}
	let end = p;
	while (end < text.length && !isSpace(text.charCodeAt(end))) end++;
	return end > p ? { start: p, end, text: REDACTED } : null;
}

/**
 * A pair whose key is the name at `start`..`nameEnd`. The key may stand in
 * quotes, as JSON writes it, those quotes escaped as many times as the JSON
 * is nested in strings, and inside `[…]`, as code indexes by it; the value
 * may be bare, quoted, in `<…>`, a number, an array or an object. After a
 * command's flag (`--password value`) the value is the next word. `signed`
 * says the text holds a signature, without which `se` and `sv` are nobody's
 * secret.
 */
function pair(
	text: string,
	start: number,
	nameEnd: number,
	signed: boolean,
	reading: Reading,
	keyFrom = start,
): Found | null {
	const name = text.slice(keyFrom, nameEnd);
	const kind = kindOf(name);
	if (!kind) return null;
	const n = text.length;
	const before = start > 0 ? text.charCodeAt(start - 1) : 0;
	let p = nameEnd;
	let quotedKey = false;
	if (isQuote(before)) {
		const escapes = escapesBefore(text, start - 2);
		const closing = escapesAt(text, p);
		if (escapes === ESCAPES_MAX && closing > ESCAPES_MAX) {
			// Escaped deeper than is counted: the key is taken as quoted when
			// its closing quote follows the run, read within `GAP_MAX`.
			let run = p;
			while (run - p < GAP_MAX && text.charCodeAt(run) === BACKSLASH) run++;
			if (text.charCodeAt(run) === before) {
				quotedKey = true;
				p = run + 1;
			}
		} else if (closing === escapes && text.charCodeAt(p + escapes) === before) {
			quotedKey = true;
			p += escapes + 1;
			// `env["KEY"]`: the key indexes, and its bracket closes before the value.
			if (
				text.charCodeAt(p) === 93 &&
				text.charCodeAt(start - 2 - escapes) === 91
			)
				p++;
		}
	}
	const gap = p;
	while (p < n && isBlank(text.charCodeAt(p))) p++;
	const separator = text.charCodeAt(p);
	if (separator !== 61 && separator !== 58) {
		// `--password value`: a command's flag, its value the next word.
		if (
			kind === "signature" ||
			quotedKey ||
			before !== 45 ||
			p === gap ||
			p >= n ||
			separator === 45 ||
			text.startsWith(REDACTED, p)
		)
			return null;
		return oneValue(text, p);
	}
	const after = text.charCodeAt(p + 1);
	// `==`, `=>` and `::` compare, map and scope; none of them gives a value.
	if (after === 61 || after === 62 || after === 58) return null;
	const assigned = separator === 61;
	if (kind === "signature") {
		const signature = name.toLowerCase() === "sig";
		if (!signature && (!signed || !assigned || quotedKey)) return null;
		if (!assigned && !quotedKey) return null;
	}
	p++;
	// A JSON value may stand on the next line; a sentence's does not.
	const spaced = quotedKey ? isSpace : isBlank;
	const reach = p + GAP_MAX;
	while (p < n && p < reach && spaced(text.charCodeAt(p))) p++;
	if (p >= n || text.startsWith(REDACTED, p)) return null;
	// `\"value\"`: a string inside a string, its quotes escaped.
	const escapes = escapesAt(text, p);
	if (escapes > ESCAPES_MAX) {
		// Escaped deeper than is counted: the value cannot be told from what
		// follows it, so the rest of the line goes with it, within `QUOTED_MAX`.
		const end = Math.min(lineEnd(text, p, reading), p + QUOTED_MAX);
		return { start: p, end, text: REDACTED };
	}
	const opens = text.charCodeAt(p + escapes);
	if (escapes <= ESCAPES_MAX && isQuote(opens)) {
		const inner = p + escapes + 1;
		const close = closingQuote(text, inner, opens, escapes);
		if (close === inner || text.slice(inner, close) === REDACTED) return null;
		return { start: inner, end: close, text: REDACTED };
	}
	if ((opens === 91 || opens === 123) && (quotedKey || !assigned)) {
		const end = closingBracket(text, p);
		return { start: p, end, text: `"${REDACTED}"` };
	}
	if (opens === 60 && assigned) {
		const inside = enclosed(text, p);
		if (inside && !text.startsWith(REDACTED, inside.start)) return inside;
	}
	if (kind === "line") {
		// Inside a quoted string the line is the string's: `-H 'Cookie: a=b' …`.
		let end = lineEnd(text, p, reading);
		if (isQuote(before) && !quotedKey) {
			const close = text.indexOf(String.fromCharCode(before), p);
			if (close >= 0 && close < end) end = close;
		}
		while (end > p && isBlank(text.charCodeAt(end - 1))) end--;
		return end > p ? { start: p, end, text: REDACTED } : null;
	}
	// A shell's working directory is `PWD` too, and is a path.
	if (
		assigned &&
		!quotedKey &&
		name.toLowerCase() === "pwd" &&
		/^(?:[/~.]|[A-Za-z]:\\)/.test(text.slice(p, p + 3))
	)
		return null;
	// After `=` a value ends where the next pair begins; after `:` only where
	// a JSON value or a clause would.
	let end = p;
	while (end < n) {
		const c = text.charCodeAt(end);
		if (assigned ? endsBare(c) : endsValue(c) || c === 44 || c === 125) break;
		end++;
	}
	const stop = assigned ? end : beforeClosing(text, p, end);
	if (stop === p) return null;
	const value = text.slice(p, stop);
	if (quotedKey) {
		if (value === "null" || value === "true" || value === "false") return null;
	} else if (!assigned && kind !== "header" && !shaped(value)) return null;
	return { start: p, end: stop, text: REDACTED };
}

/**
 * Where the command that begins at `start` ends: its line's end, or, while a
 * line ends in a continuation (`\` in a shell, `` ` `` in PowerShell, `^` in
 * cmd), the next line's. Each line is walked once.
 */
function commandEnd(text: string, start: number, reading: Reading): number {
	let end = lineEnd(text, start, reading);
	for (;;) {
		let last = end;
		while (last > start && isBlank(text.charCodeAt(last - 1))) last--;
		const c = text.charCodeAt(last - 1);
		if (end >= text.length || !(c === BACKSLASH || c === 96 || c === 94))
			return end;
		let next = end + 1;
		if (text.charCodeAt(end) === CR && text.charCodeAt(next) === LF) next++;
		end = next;
		while (end < text.length) {
			const d = text.charCodeAt(end);
			if (d === LF || d === CR) break;
			end++;
		}
	}
}

/** `curl`'s `-u user:password` and `--user user:password`: the flag is known for a credential by the command before it. */
function curlUser(
	text: string,
	start: number,
	nameEnd: number,
	reading: Reading,
): Found | null {
	if (start >= reading.curlUntil || text.charCodeAt(start - 1) !== 45)
		return null;
	let p = nameEnd;
	while (p < text.length && isBlank(text.charCodeAt(p))) p++;
	if (p === nameEnd || text.startsWith(REDACTED, p)) return null;
	return oneValue(text, p);
}

/** What begins at the word that starts at `start`, if a rule knows it. */
function atWord(
	text: string,
	start: number,
	signed: boolean,
	reading: Reading,
): Found | null {
	const n = text.length;
	if (text.startsWith("eyJ", start)) {
		const token = signedToken(text, start, reading);
		if (token) return token;
	}
	if (isLetter(text.charCodeAt(start))) {
		let schemeEnd = start;
		while (
			schemeEnd < n &&
			schemeEnd - start < SCHEME_MAX &&
			isScheme(text.charCodeAt(schemeEnd))
		)
			schemeEnd++;
		if (text.startsWith("://", schemeEnd))
			return url(text, start, schemeEnd, reading);
	}
	let nameEnd = nameRun(text, start, reading);
	while (nameEnd > start && text.charCodeAt(nameEnd - 1) === 45) nameEnd--;
	// A key longer than a name is read by its last `NAME_MAX` characters,
	// which is where the word that names a credential stands.
	if (nameEnd - start > NAME_MAX)
		return pair(text, start, nameEnd, signed, reading, nameEnd - NAME_MAX);
	const name = text.slice(start, nameEnd);
	if (METHODS.has(name)) return requestLine(text, nameEnd);
	const lower = name.toLowerCase();
	if (lower === "bearer" || lower === "basic") {
		const credential = schemeCredential(text, nameEnd);
		if (credential) return credential;
	}
	if (lower === "curl" && start >= reading.curlUntil)
		reading.curlUntil = commandEnd(text, start, reading);
	if (name === "u" || name === "user") {
		const user = curlUser(text, start, nameEnd, reading);
		if (user) return user;
	}
	return pair(text, start, nameEnd, signed, reading);
}

/** `sig=`, as a query or a connection string writes a shared access signature. */
const SIGNATURE = /(?:^|[^A-Za-z0-9_-])sig=/i;

/** One reading of `text`, left to right. */
function scan(text: string): string {
	const n = text.length;
	const signed = SIGNATURE.test(text);
	const reading: Reading = {
		noTokenBefore: 0,
		lineFrom: 1,
		lineTo: 0,
		curlUntil: 0,
		nameFrom: 1,
		nameTo: 0,
		authorityFrom: 1,
		authorityTo: 0,
		authorityLastAt: -1,
	};
	const out: string[] = [];
	/** Where the text not yet written out begins. */
	let from = 0;
	/** Up to here a path was read and held no query, so nothing before it starts one. */
	let noQueryBefore = 0;
	/** The last character written in place of what was taken: what stands before `from` in the record. */
	let written = 0;
	let i = 0;
	const take = (found: Found): void => {
		out.push(text.slice(from, found.start), found.text);
		from = found.end;
		i = found.end;
		written = found.text.charCodeAt(found.text.length - 1) || 0;
	};
	while (i < n) {
		const c = text.charCodeAt(i);
		// What precedes a place is read as it will be recorded, so a second
		// reading of the record meets the same boundaries as the first.
		const prior = i === 0 ? 0 : i === from ? written : text.charCodeAt(i - 1);
		// A word begins at a letter, a digit or `_`: `_authToken` and
		// `2fa_secret` are keys as much as `token` is.
		if (isWord(c)) {
			if (isWord(prior)) {
				i++;
				continue;
			}
			const found = atWord(text, i, signed, reading);
			if (found) {
				take(found);
				continue;
			}
			// A signed token may be glued to the word before it (`_eyJ…`,
			// `1eyJ…`): the rest of the word is looked through for one.
			let glued: Found | null = null;
			i++;
			while (i < n && isWord(text.charCodeAt(i))) {
				if (text.startsWith("eyJ", i)) glued = signedToken(text, i, reading);
				if (glued) break;
				i++;
			}
			if (glued) take(glued);
			continue;
		}
		if (c === AT) {
			const found = address(text, i, from);
			if (found) {
				take(found);
				continue;
			}
		} else if (
			c === SLASH &&
			i >= noQueryBefore &&
			!isWord(prior) &&
			// After a `:` a path is one (`redirect:/cb?…`), where `://` opens a URL.
			!(prior === 58 && text.charCodeAt(i + 1) === SLASH) &&
			prior !== SLASH &&
			prior !== 46
		) {
			const end = pathEnd(text, i + 1);
			const queried =
				text.charCodeAt(end) === 63 ? pathAndQuery(text, i, end) : null;
			if (queried) {
				take(queried);
				continue;
			}
			noQueryBefore = end;
		}
		i++;
	}
	out.push(text.slice(from));
	return out.join("");
}

/**
 * Every word and mark a rule here begins at or looks for, taken from the
 * rules' own tables. The test that holds the reading to a time builds its
 * texts out of these, so a rule added to a table is timed without anyone
 * remembering to.
 */
export const RECOGNISED: readonly string[] = [
	...LOCAL_SCHEMES,
	...METHODS,
	...SIGNATURE_KEYS,
	...CREDENTIAL_STEMS,
	"apikey",
	"subscriptionkey",
	"cookie",
	"set-cookie",
	"authorization",
	"Bearer",
	"Basic",
	"curl",
	"-u",
	"--user",
	"eyJ",
	"://",
	"@",
	"/",
	"?",
	"=",
	":",
	'"',
	"'",
	"\\",
	"<",
	">",
	"[",
	"]",
	"{",
	"}",
	REDACTED,
	TRUNCATED,
];

/** `text` held to `SCANNED_MAX`, cut where a word ended so no value is left in half. */
function held(text: string): string {
	let cut = SCANNED_MAX;
	while (cut > 0 && !isSpace(text.charCodeAt(cut))) cut--;
	return text.slice(0, cut);
}

export function scrubText(text: string): string {
	let cut = text.endsWith(TRUNCATED);
	let body = cut ? text.slice(0, -TRUNCATED.length) : text;
	if (body.length > SCANNED_MAX) {
		body = held(body);
		cut = true;
	}
	let recorded = scan(body);
	if (recorded.length > SCANNED_MAX) {
		recorded = held(recorded);
		cut = true;
	}
	return cut ? `${recorded}${TRUNCATED}` : recorded;
}
