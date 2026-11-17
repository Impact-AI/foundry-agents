import {
	backendFetch,
	type Caller,
	errorOf,
	relayResponse,
} from "@/src/backend/client";
import { withCaller } from "@/src/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Formats a browser renders inertly; SVG is a document that can carry script. */
const RASTER = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/tiff",
]);

/**
 * What relayed bytes may do on this origin, opened directly or drawn in an
 * `<img>`: be a picture. No script, no subresource, a sandbox around
 * anything that slipped through, and no sniffing past the declared type.
 * `next.config.ts` leaves this route out of the page policy, which would
 * otherwise win.
 */
const MEDIA_HEADERS = {
	// Whether this caller may see the picture is asked again on every draw:
	// a copy the browser kept would outlive the session that was allowed it.
	// The browser names the copy it holds and is told 304 when it still
	// stands, so asking again does not mean sending the bytes again.
	"Cache-Control": "private, no-cache",
	"Content-Security-Policy":
		"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
	"X-Content-Type-Options": "nosniff",
};

function isRaster(contentType: string | null): boolean {
	const essence = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return RASTER.has(essence);
}

const PREFIX = "/api/media/";

/**
 * The path below `/api/media/`, each segment re-encoded, or null for one that
 * does not decode or would climb: what reaches the backend is always a path
 * under its own media route.
 */
function keyPath(req: Request): string | null {
	const path = new URL(req.url).pathname;
	if (!path.startsWith(PREFIX)) return null;
	try {
		const segments = path
			.slice(PREFIX.length)
			.split("/")
			.map(decodeURIComponent);
		if (
			segments.some(
				(s) => s === "" || s === "." || s === ".." || s.includes("/"),
			)
		)
			return null;
		return segments.map(encodeURIComponent).join("/");
	} catch {
		return null;
	}
}

/**
 * A picture of the knowledge base, by its path in the library container, through the
 * backend's media route: the bytes stream through, the policy — whether
 * this caller may see it — is the backend's. This side holds the line on
 * what it hands the browser: a raster image, unable to act as a page.
 */
export const media = async (
	caller: Caller,
	req: Request,
): Promise<Response> => {
	const key = keyPath(req);
	if (!key) return Response.json({ code: "bad_request" }, { status: 400 });
	const held = req.headers.get("if-none-match");
	const res = await backendFetch(caller, `/media/${key}`, {
		signal: req.signal,
		...(held ? { headers: { "If-None-Match": held } } : {}),
	});
	if (res.status === 304) {
		// The copy the browser holds stands, and this caller may still see it.
		const etag = res.headers.get("etag");
		return new Response(null, {
			status: 304,
			headers: { ...MEDIA_HEADERS, ...(etag ? { ETag: etag } : {}) },
		});
	}
	if (!res.ok) throw await errorOf(res);
	if (!isRaster(res.headers.get("content-type"))) {
		await res.body?.cancel();
		return Response.json(
			{ code: "unsupported_type" },
			{ status: 415, headers: MEDIA_HEADERS },
		);
	}
	const relayed = relayResponse(res);
	for (const [name, value] of Object.entries(MEDIA_HEADERS))
		relayed.headers.set(name, value);
	return relayed;
};

export const GET = withCaller(media);
