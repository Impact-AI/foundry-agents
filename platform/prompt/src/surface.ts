/**
 * Which interface the agent is being driven from, as the client declares it.
 * A client hands the agent tools the agent cannot see, so guidance written
 * for a different set sends it calling a control nobody registered. The
 * surface travels as a readable registered under one exact description.
 */
export const UI_SURFACE_READABLE = "Client surface";

/** A readable's value as a known surface, raw or JSON-encoded, or `null`. An unknown string is refused, never passed through. */
export function parseUiSurface<S extends string>(
	value: unknown,
	known: readonly S[],
): S | null {
	if (typeof value !== "string") return null;
	const isKnown = (candidate: string): candidate is S =>
		(known as readonly string[]).includes(candidate);
	if (isKnown(value)) return value;
	try {
		const decoded: unknown = JSON.parse(value);
		if (typeof decoded === "string" && isKnown(decoded)) return decoded;
	} catch {}
	return null;
}

/** What a tool result adds to say the line is due now. Rides on every interface tool call. */
export const FOLLOW_UP_CUE = "Now say your line about it.";

/** For results that put something in front of the person, never for the ones that take it away or that failed. */
export function withFollowUp(result: string): string {
	return `${result} ${FOLLOW_UP_CUE}`;
}
