import {
	azureCredential,
	createEntraAccessTokenProvider,
	type EntraAccessTokenProvider,
	processSingleton,
} from "@platform/config";
import { redisUrl } from "./options";

/**
 * How the process authenticates to Redis, read off `REDIS_URL`. Azure Managed
 * Redis with access keys off takes an Entra token as the password and the
 * identity's object id as the user, so a URL that names a user and no
 * password — `rediss://<objectId>@<host>:10000` — is the Entra form, and the
 * token is minted per dial because it expires. A URL with a password is used
 * as given.
 */

export const REDIS_ENTRA_SCOPE = "https://redis.azure.com/.default";

/** The port an Azure Managed Redis database answers on, for a URL that names none. */
const MANAGED_REDIS_PORT = 10000;

export type RedisAuth =
	| {
			mode: "url";
			url: string;
			host: string;
			form: "password" | "none";
	  }
	| {
			mode: "entra";
			objectId: string;
			host: string;
			port: number;
			tls: boolean;
			form: "entra";
	  };

export const REDIS_TOKEN_PROVIDER = "redis-token-provider";

export function redisTokenProvider(): EntraAccessTokenProvider {
	return processSingleton(REDIS_TOKEN_PROVIDER, () =>
		createEntraAccessTokenProvider({
			credential: azureCredential,
			scope: REDIS_ENTRA_SCOPE,
			hint: "Check that the identity exists (AZURE_CLIENT_ID) and holds an access policy on the cache.",
		}),
	);
}

/** The one place that decides how this process authenticates; `undefined` when no Redis is configured. */
export function resolveRedisAuth(): RedisAuth | undefined {
	const url = redisUrl();
	if (!url) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// Not a URL at all: the dial will say so, as it always has.
		return { mode: "url", url, host: url, form: "none" };
	}
	if (parsed.username && !parsed.password) {
		return {
			mode: "entra",
			objectId: decodeURIComponent(parsed.username),
			host: parsed.hostname,
			port: parsed.port ? Number(parsed.port) : MANAGED_REDIS_PORT,
			tls: parsed.protocol === "rediss:",
			form: "entra",
		};
	}
	return {
		mode: "url",
		url,
		host: parsed.hostname,
		form: parsed.password ? "password" : "none",
	};
}

/** The URL the client dials for the Entra form, carrying the token minted for this dial. */
export function entraRedisUrl(
	auth: RedisAuth & { mode: "entra" },
	token: string,
): string {
	const scheme = auth.tls ? "rediss" : "redis";
	return `${scheme}://${encodeURIComponent(auth.objectId)}:${encodeURIComponent(token)}@${auth.host}:${auth.port}`;
}

export function describeRedisAuth(auth: RedisAuth): string {
	switch (auth.form) {
		case "entra":
			return `an Entra token as ${auth.objectId}`;
		case "password":
			return "the password in REDIS_URL";
		case "none":
			return "no credential";
	}
}
