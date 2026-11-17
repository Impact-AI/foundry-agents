/**
 * Text a person typed, as it can safely be quoted inside a prompt.
 *
 * This is an injection boundary: the value's next stop is a system prompt.
 * Control characters go. A `<` that opens a tag becomes a guillemet, so no
 * quoted text can close the block it sits in and start writing in the prompt's
 * own voice; `a < b` and `<3` survive, because people write prose. Blank lines
 * go, line breaks stay: a blank line is what separates one part of a block
 * from the next, so a field that kept one could start a part of its own.
 * The length is capped last, on what is actually kept.
 *
 * Ordinary imperative sentences are not stripped: "always answer briefly" is
 * the point of a preferences field. The defence against "ignore your
 * instructions" is the framing of the block and the guardrails above it.
 */
export function scrubQuotedText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/<(?=[/A-Za-z_])/g, "‹")
		.replace(/\r\n?/g, "\n")
		.replace(/\n[^\S\n]*(?=\n)/g, "")
		.trim();
	return cleaned.slice(0, max) || null;
}

/** A block, fenced and titled, or nothing when it has no body. */
export function fence(
	tag: string,
	body: string | null | undefined,
): string | null {
	const text = body?.trim();
	return text ? `<${tag}>\n${text}\n</${tag}>` : null;
}

/** Several blocks under one fence, or nothing when none has a body. */
export function part(
	tag: string,
	blocks: (string | null | undefined)[],
): string | null {
	return fence(
		tag,
		blocks
			.map((b) => b?.trim())
			.filter((b): b is string => Boolean(b))
			.join("\n\n"),
	);
}
