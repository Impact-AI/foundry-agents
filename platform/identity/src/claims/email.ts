/**
 * The storage form of an address, or `null` when the text is not one:
 * trimmed, unwrapped from a `Name <a@b.c>` display form, lower-cased. One
 * definition of "the same address" for every lookup.
 *
 * The shape test is loose on purpose: address syntax is more permissive than
 * any regex worth shipping, and what this must catch is a header row or a
 * stray note, not an unusual mailbox.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
	if (!raw) return null;
	let text = raw.trim();
	const angled = /<([^<>]+)>\s*$/.exec(text);
	if (angled?.[1]) text = angled[1].trim();
	text = text.replace(/^mailto:/i, "").toLowerCase();
	const at = text.indexOf("@");
	if (at <= 0 || at !== text.lastIndexOf("@")) return null;
	const domain = text.slice(at + 1);
	if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith("."))
		return null;
	if (/[\s,;"<>()[\]\\]/.test(text)) return null;
	return text;
}
