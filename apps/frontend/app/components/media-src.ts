import { isMediaPath } from "@/src/same-origin";

/**
 * A picture the assistant handed us, as a `src`: a path under this origin's
 * media route, which the backend hands out, or bytes already in the page.
 * Anything naming another host is no picture at all, so a URL in
 * model-written text can carry nothing the turn knew to a host that logs
 * requests.
 */
export function mediaSrc(url: string): string | null {
	if (isMediaPath(url)) return url;
	if (url.startsWith("data:") || url.startsWith("blob:")) return url;
	return null;
}
