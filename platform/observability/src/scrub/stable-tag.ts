/**
 * A stable, unreadable tag for a value that must not appear in a log: the
 * same sixteen hex characters every time for the same input, so two records
 * can be recognised as being about one subject, and not the input.
 *
 * This is pseudonymisation, not anonymisation. A low-entropy value such as an
 * email address can be tagged by anyone holding a list of candidates, with
 * this hash as with any other; what it buys is that the plaintext is not in
 * a retained, queryable store. FNV-1a rather than a cryptographic hash because
 * the first caller is synchronous in a runtime with no synchronous digest, and
 * the threat model above is not improved by a stronger one.
 */

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;
/** The second pass's basis; any constant that is not the first one will do. */
const FNV_OFFSET_REVERSE = 0x9e3779b9;

/**
 * Two 32-bit passes, the second backwards with a different basis so the two
 * halves do not move together, rather than the 64-bit variant: a `BigInt`
 * literal is a type error in a browser bundle targeting below ES2020.
 */
function fnv1a(text: string, offset: number, reverse: boolean): number {
	let hash = offset >>> 0;
	const last = text.length - 1;
	for (let i = 0; i <= last; i++) {
		hash ^= text.charCodeAt(reverse ? last - i : i);
		hash = Math.imul(hash, FNV_PRIME) >>> 0;
	}
	return hash >>> 0;
}

/** Not a secret; it only stops two unrelated logs being joined on a tag. */
const DOMAIN = "platform:v1:";

/**
 * `"-"` for null, undefined or blank: "there was no value" and "there was a
 * value and here is its tag" are different facts.
 */
export function stableTag(value: string | null | undefined): string {
	const input = value?.trim().toLowerCase();
	if (!input) return "-";
	const text = `${DOMAIN}${input}`;
	const high = fnv1a(text, FNV_OFFSET, false);
	const low = fnv1a(text, FNV_OFFSET_REVERSE, true);
	return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}
