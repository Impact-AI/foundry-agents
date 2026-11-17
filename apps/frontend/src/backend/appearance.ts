import {
	type AppearanceSettings,
	appearanceDefaults,
	LOGO_MAX_BYTES,
	LOGO_TYPES,
	logoVersion,
	parseAppearance,
} from "@platform/appearance";
import { locales } from "../i18n/locales";
import { backendUrl } from "./client";
import { memoised } from "./facts";

/**
 * The deployment's appearance, from the backend's public `GET /appearance`:
 * the same for every caller and wanted before anybody has signed in, so it
 * asks for no session, is read once per process and is served from memory at
 * the pace every stored document is — an edit in the store reaches a page
 * within a minute, the backend's memo and this one together.
 *
 * It never throws and never breaks a page. What the backend answers is
 * parsed again here, against this app's own languages, because it is
 * written into a `<style>` element; a failed read serves the last answer,
 * or the shipped look before the first, and says so in the log.
 */

const DEFAULTS = appearanceDefaults(locales.codes);

/**
 * How long either read waits for the backend to answer. A slow backend costs
 * a page its look or its logo, never its answer.
 */
const BACKEND_DEADLINE_MS = 3_000;

/** A reader with a memo of its own: the process holds one, a test as many as it likes. */
export function appearanceReader(): () => Promise<AppearanceSettings> {
	let lastGood: AppearanceSettings | undefined;
	return memoised(async (): Promise<AppearanceSettings> => {
		try {
			const res = await fetch(`${backendUrl()}/appearance`, {
				cache: "no-store",
				signal: AbortSignal.timeout(BACKEND_DEADLINE_MS),
			});
			if (!res.ok) throw new Error(`the backend answered ${res.status}`);
			lastGood = parseAppearance(await res.json(), DEFAULTS);
			return lastGood;
		} catch (err) {
			console.warn(
				`[appearance] unreadable — serving ${lastGood ? "the last good value" : "the shipped look"}:`,
				err instanceof Error ? err.message : err,
			);
			return lastGood ?? DEFAULTS;
		}
	});
}

export const readAppearance = appearanceReader();

/**
 * Where a page draws the deployment's logo from: this app's own relay, at an
 * address that carries the logo's hash, so a new logo is never served from a
 * cache of the old. Empty when the deployment has none.
 */
export function logoSrc(appearance: AppearanceSettings): string {
	const key = appearance.brand.logo;
	return key ? `/api/appearance/logo?v=${logoVersion(key)}` : "";
}

const RASTERS = new Set<string>(LOGO_TYPES);

/** A stream that passes `max` bytes and fails on the next: a body that says no length is held to the bound all the same. */
function atMost(max: number): TransformStream<Uint8Array, Uint8Array> {
	let seen = 0;
	return new TransformStream({
		transform(chunk, controller) {
			seen += chunk.byteLength;
			if (seen > max)
				controller.error(new Error(`the logo is larger than ${max} bytes`));
			else controller.enqueue(chunk);
		},
	});
}

const INERT = {
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"X-Content-Type-Options": "nosniff",
};

/**
 * The deployment's logo, relayed from the backend's public
 * `GET /appearance/logo`. It takes nothing from the request but a
 * revalidation — no key, no path, no cookie — so it can serve that one
 * picture and nothing else, and is no proxy for any other address. Relayed
 * only as one of the four rasters a logo may be, no larger than the backend
 * serves one, inert, and cached against its hash. Anything else is a 404,
 * and a backend that is down or has not answered within `deadlineMs` is a
 * 502.
 *
 * The fetch always carries a signal, and that is load-bearing twice. The
 * deadline bounds the wait for the backend's answer (headers only — the body
 * is paced by the stream, not cut off by it). And a signal is how a call
 * opts out of Next's request-scoped fetch dedupe, which otherwise tees every
 * GET body and keeps the second branch unread: a cancel of one tee branch
 * settles only once the other is cancelled too, so `res.body.cancel()` on a
 * refusal would never settle and the route would never answer.
 */
export async function relayLogo(
	req: Request,
	deadlineMs: number = BACKEND_DEADLINE_MS,
): Promise<Response> {
	const ifNoneMatch = req.headers.get("if-none-match");
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new Error(`no answer within ${deadlineMs}ms`)),
		deadlineMs,
	);
	let res: Response;
	try {
		res = await fetch(`${backendUrl()}/appearance/logo`, {
			headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {},
			cache: "no-store",
			signal: AbortSignal.any([req.signal, deadline.signal]),
		});
	} catch (err) {
		console.warn(
			"[appearance] the logo is unreachable:",
			err instanceof Error ? err.message : err,
		);
		return new Response(null, { status: 502, headers: INERT });
	} finally {
		clearTimeout(timer);
	}
	const etag = res.headers.get("etag");
	const cache = {
		...(etag ? { ETag: etag } : {}),
		"Cache-Control": res.headers.get("cache-control") ?? "no-store",
	};
	if (res.status === 304)
		return new Response(null, { status: 304, headers: { ...INERT, ...cache } });
	const type = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
	const length = Number(res.headers.get("content-length") ?? 0);
	if (!res.ok || !RASTERS.has(type) || !(length <= LOGO_MAX_BYTES)) {
		await res.body?.cancel();
		return new Response(null, {
			status: 404,
			headers: { ...INERT, "Cache-Control": "no-store" },
		});
	}
	return new Response(res.body?.pipeThrough(atMost(LOGO_MAX_BYTES)), {
		headers: { ...INERT, ...cache, "Content-Type": type },
	});
}
