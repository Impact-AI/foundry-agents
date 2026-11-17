/** A wait in seconds as the catalogue's `wait.*` phrase wants it. */
export function waitPhrase(seconds: number): {
	key: "moment" | "minutes" | "hours";
	count: number;
} {
	if (seconds < 90) return { key: "moment", count: 1 };
	if (seconds < 3600)
		return { key: "minutes", count: Math.max(1, Math.round(seconds / 60)) };
	return { key: "hours", count: Math.max(1, Math.round(seconds / 3600)) };
}
