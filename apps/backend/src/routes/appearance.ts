import { LOGO_MAX_BYTES, logoKeyType, logoVersion } from "@platform/appearance";
import { appearanceSettings } from "@platform/appearance/settings";
import { envString } from "@platform/config";
import type { LocaleRegistry } from "@platform/i18n";
import { readBlob } from "@platform/storage";
import { Hono } from "hono";
import type { AppEnv } from "../auth/context";
import { refuse } from "./reply";

/**
 * The container the logo is read from: one of its own on the store's
 * account, apart from the library, so AI Search's indexer never reads a logo
 * as a document and no library is named `appearance`.
 */
function appearanceContainer(): string {
	return envString("AZURE_STORAGE_APPEARANCE_CONTAINER") ?? "appearance";
}

/**
 * The deployment's look, public, ahead of the gate: the sign-in door wears
 * it before anybody has signed in, and it holds nothing about any person.
 *
 * - `GET /appearance` — the `appearance` document as its reader makes of the
 *   store: the shipped look when nothing is stored, the last good value over
 *   a failed read.
 * - `GET /appearance/logo` — the one picture that document names, and only
 *   it: the key comes from the document, never from the request, so this
 *   opens no other object. Served only when the stored object is the raster
 *   its key says, no larger than {@link LOGO_MAX_BYTES}, inert, and cached
 *   against the hash in its key — a new logo is a new ETag. The key is named
 *   for the logo's bytes, so the bytes under one key never change: the last
 *   logo served is held in memory against its key, one at most, and a repeat
 *   request reads nothing from the store. Only a logo that passed every check
 *   is held; a refusal is asked of the store again next time.
 */
export function appearanceRoutes(
	locales: LocaleRegistry<string>,
): Hono<AppEnv> {
	const read = () => appearanceSettings(locales.codes).read();
	/** The last logo served, under its key; replaced when the document names another. */
	let held: { key: string; bytes: Uint8Array<ArrayBuffer> } | undefined;
	return new Hono<AppEnv>()
		.get("/appearance", async (c) =>
			c.json(await read(), 200, { "Cache-Control": "no-store" }),
		)
		.get("/appearance/logo", async (c) => {
			const key = (await read()).brand.logo;
			const type = key ? logoKeyType(key) : null;
			if (!key || !type) return refuse(c, 404, "not_found");
			const etag = `"${logoVersion(key)}"`;
			const cache = { ETag: etag, "Cache-Control": "public, max-age=300" };
			if (c.req.header("if-none-match") === etag)
				return new Response(null, { status: 304, headers: cache });
			const headers = {
				...cache,
				"Content-Type": type,
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; sandbox",
			};
			if (held?.key !== key) {
				const bytes = await readLogo(key, type);
				if (!bytes) return refuse(c, 404, "not_found");
				held = { key, bytes };
			}
			return new Response(held.bytes, {
				headers: { ...headers, "Content-Length": String(held.bytes.length) },
			});
		});
}

/**
 * The logo `key` names, whole, when the stored object is the raster `type`
 * its key says and no larger than {@link LOGO_MAX_BYTES} — declared and
 * read; null for anything else.
 */
async function readLogo(
	key: string,
	type: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const object = await readBlob(key, appearanceContainer());
	if (!object) return null;
	const stored = object.contentType?.split(";")[0]?.trim().toLowerCase();
	if (
		stored !== type ||
		object.contentLength === undefined ||
		object.contentLength > LOGO_MAX_BYTES
	) {
		await object.body.cancel();
		return null;
	}
	const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
	return bytes.length === object.contentLength ? bytes : null;
}
