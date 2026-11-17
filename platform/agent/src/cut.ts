/**
 * A string held to a length, in the UTF-16 units every bound here counts:
 * a cut that would fall between the two halves of a character outside the
 * basic plane gives the whole character up, so what is kept is always
 * well formed. Pure, so a browser cuts as the server does.
 */
export function cutTo(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, Math.max(0, max));
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
