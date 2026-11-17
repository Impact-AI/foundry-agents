import { pictureFor } from "@platform/knowledge";
import {
	isUnmetered,
	keys,
	meterCall,
	rateLimitedResponse,
	spendCredits,
} from "@platform/metering";
import { type BlobEntry, readBlob } from "@platform/storage";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth/context";
import { accessOf, callerAccess, requireStanding } from "../auth/standing";
import { problems } from "../problems";
import { refuse } from "./reply";

/** Formats a browser draws inertly; SVG is a document that can carry script. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** On every picture: if a browser is ever talked into opening one as a page, it runs nothing and loads nothing. */
const INERT = {
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"X-Content-Type-Options": "nosniff",
};

/**
 * How often an account may ask whether the copy it holds still stands: a
 * question that reads no picture out of the store and costs no credit of
 * the day, held to its own bound so it cannot be asked without end. Ten a
 * second, with a minute's worth at once: a stage redrawn with every
 * picture it shows stays well inside it.
 */
const REVALIDATIONS = { capacity: 600, refillPerMinute: 600 };

/**
 * A picture of the knowledge base by its path in the library container:
 * `GET /media/{library}/{path}`. Read from the deployment's own store with this
 * process's identity and streamed, so nothing that could open a blob ever
 * reaches a client and no other host is ever asked. The blob decides who:
 * a picture the job described, whose readers admit the caller under the
 * rule a search applies — never a document, a manifest, or a blob nobody
 * described. Absent and not yours are one answer, so a path cannot be
 * probed.
 *
 * A browser asks again on every draw (`no-cache`), so whether the caller
 * may still see the picture is decided each time. It names the copy it
 * holds (`If-None-Match`), and when the blob's content is exactly that
 * copy the answer is 304 with no bytes. Only a tag that is the content's
 * own earns it: `*` names no copy, so it is answered as a request for the
 * picture. The validator is the content's MD5 as the store holds it; a
 * blob the store holds no MD5 for is sent whole each time.
 *
 * What each answer costs is decided before the store is asked anything. A
 * request that names a copy draws on the revalidation bound alone, and a
 * 304 is all it gets from it: the day's allowance is not touched, so a
 * picture a browser already holds still draws once that allowance is
 * spent. Everything else — no copy named, a copy that is no longer the
 * content, a picture that is not the caller's — draws on the day's
 * allowance before the picture is read, and a refusal there is the 429.
 * The blob's properties are read once, for who may see it and for its
 * validator both.
 */
export function mediaRoutes(): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();
	routes.use("*", requireStanding);

	routes.get("/*", async (c) => {
		const path = pathOf(c);
		if (path === null) return refused(c, 400, "invalid_path");
		const tier = accessOf(c).tier;
		const subject = c.get("subject");
		const named = copiesNamed(c.req.header("if-none-match"));
		let picture: BlobEntry | null | undefined;
		if (
			named.length > 0 &&
			(isUnmetered(tier) ||
				(await spendCredits(keys.burst(subject, "media"), REVALIDATIONS))
					.allowed)
		) {
			picture = await pictureFor(path, callerAccess(c));
			const etag = picture && validatorOf(picture.contentMD5);
			if (etag && named.includes(etag))
				return new Response(null, {
					status: 304,
					headers: { ...INERT, ETag: etag, "Cache-Control": REVALIDATE },
				});
		}
		const verdict = await meterCall(subject, "media", tier);
		if (!verdict.ok) return rateLimitedResponse(verdict.refusal);
		if (picture === undefined)
			picture = await pictureFor(path, callerAccess(c));
		if (!picture) return refused(c, 404, "not_found");
		const etag = validatorOf(picture.contentMD5);
		const object = await readBlob(path);
		if (!object) return refused(c, 404, "not_found");
		const type = object.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
		if (!RASTER.has(type)) {
			await object.body.cancel();
			return refused(c, 415, "unsupported_type");
		}
		return new Response(object.body, {
			headers: {
				...INERT,
				"Content-Type": type,
				...(object.contentLength === undefined
					? {}
					: { "Content-Length": String(object.contentLength) }),
				...(etag ? { ETag: etag } : {}),
				"Cache-Control": REVALIDATE,
			},
		});
	});

	return routes;
}

/**
 * Private: who may see it is decided per person, and a shared cache would
 * answer the next person without asking. Asked again on every use: a copy
 * may be drawn only after this route has said the caller may still see it.
 */
const REVALIDATE = "private, no-cache";

/** The content's validator: its MD5 as the store holds it, quoted as an entity tag. */
function validatorOf(md5: Uint8Array | undefined): string | null {
	return md5?.length ? `"${Buffer.from(md5).toString("base64")}"` : null;
}

/** The copies a request names, weak or strong, as entity tags. `*` names none: it says only that some copy is held. */
function copiesNamed(header: string | undefined): string[] {
	if (!header) return [];
	return header
		.split(",")
		.map((tag) => tag.trim().replace(/^W\//, ""))
		.filter((tag) => /^"[^"]*"$/.test(tag));
}

const PREFIX = "/media/";

/**
 * The blob the path names, each segment decoded, or null for one that does
 * not decode, would climb, or carries a control character: a blob name is
 * taken as written, so nothing that is not one plain path reaches the store.
 */
function pathOf(c: Context<AppEnv>): string | null {
	const raw = new URL(c.req.url).pathname;
	if (!raw.startsWith(PREFIX)) return null;
	let segments: string[];
	try {
		segments = raw.slice(PREFIX.length).split("/").map(decodeURIComponent);
	} catch {
		return null;
	}
	const plain = (s: string) =>
		// biome-ignore lint/suspicious/noControlCharactersInRegex: excluding them is the point
		s !== "" && s !== "." && s !== ".." && !/[/\\\x00-\x1f\x7f]/.test(s);
	return segments.length >= 2 && segments.every(plain)
		? segments.join("/")
		: null;
}

function refused(
	c: Context<AppEnv>,
	status: 400 | 404 | 415,
	code: "invalid_path" | "not_found" | "unsupported_type",
): Response {
	problems.report("backend.media.refused", { status, reason: code });
	return refuse(c, status, code);
}
