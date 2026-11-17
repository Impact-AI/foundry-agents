import { isSameOriginPath } from "@/src/same-origin";

/** Where a sign-in returns to: a path on this origin, or the chat. */
export function returnPath(value: string | null): string {
	return value && isSameOriginPath(value) ? value : "/chat";
}
