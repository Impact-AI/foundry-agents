/**
 * A cached, self-refreshing Entra access token for one scope.
 *
 * An access token lives about an hour, so it can neither be captured once at
 * startup nor minted per call. Concurrent callers share one in-flight mint; a
 * refresh that fails while the cached token is still valid serves the cached
 * token rather than failing the call.
 *
 * The credential is injected as a factory, so this module needs no Azure SDK,
 * a process that never uses token auth never loads one, and tests run without
 * Azure.
 */

/** Mint again this long before the cached token expires. */
export const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * The longest a caller waits on one mint.
 *
 * A mint that hangs is worse than one that fails: a database driver awaiting
 * the password callback has no timeout on that phase, so an unsettled mint
 * parks the connection slot for ever, and the pool is dead until restart. A
 * mint that rejects is retried on the next call. The underlying request is not
 * cancelled; a token that lands late is still a valid token and is cached for
 * the next caller.
 */
export const DEFAULT_MINT_TIMEOUT_MS = 30_000;

export interface AccessTokenLike {
	token: string;
	/** Milliseconds since the epoch. */
	expiresOnTimestamp: number;
}

export interface TokenCredentialLike {
	getToken(scopes: string | string[]): Promise<AccessTokenLike | null>;
}

export interface EntraTokenProviderOptions {
	/** Resolves the credential lazily, once. */
	credential: () => TokenCredentialLike | Promise<TokenCredentialLike>;
	/** The `.default` scope of the resource being called. */
	scope: string;
	/** Appended to the "no token" error: what to check for this resource. */
	hint?: string;
	refreshMarginMs?: number;
	mintTimeoutMs?: number;
	/** Injectable clock, for tests. */
	now?: () => number;
}

export type EntraTokenProvider = () => Promise<string>;

/** The token with its expiry, for a client that must act before it lapses. */
export type EntraAccessTokenProvider = () => Promise<AccessTokenLike>;

export function createEntraTokenProvider(
	options: EntraTokenProviderOptions,
): EntraTokenProvider {
	const accessToken = createEntraAccessTokenProvider(options);
	return async () => (await accessToken()).token;
}

export function createEntraAccessTokenProvider(
	options: EntraTokenProviderOptions,
): EntraAccessTokenProvider {
	const { scope } = options;
	const marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
	const mintTimeoutMs = options.mintTimeoutMs ?? DEFAULT_MINT_TIMEOUT_MS;
	const now = options.now ?? Date.now;
	const hint =
		options.hint ??
		"Check that AZURE_CLIENT_ID names an identity that exists and holds a role on the resource.";

	let credential: TokenCredentialLike | undefined;
	let cached: AccessTokenLike | undefined;
	let inFlight: Promise<AccessTokenLike> | undefined;

	async function mint(): Promise<AccessTokenLike> {
		credential ??= await options.credential();
		const token = await credential.getToken(scope);
		if (!token?.token) {
			throw new Error(`Entra returned no access token for ${scope}. ${hint}`);
		}
		return token;
	}

	function remember(token: AccessTokenLike): void {
		if (!cached || token.expiresOnTimestamp > cached.expiresOnTimestamp) {
			cached = token;
		}
	}

	function mintBounded(): Promise<AccessTokenLike> {
		const underlying = mint();
		underlying.then(remember, () => {});
		return new Promise<AccessTokenLike>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`Entra token request for ${scope} did not settle within ${mintTimeoutMs}ms. ${hint}`,
					),
				);
			}, mintTimeoutMs);
			(timer as { unref?: () => void }).unref?.();
			underlying.then(
				(token) => {
					clearTimeout(timer);
					resolve(token);
				},
				(err) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	}

	return async function accessToken(): Promise<AccessTokenLike> {
		if (cached && now() < cached.expiresOnTimestamp - marginMs) {
			return cached;
		}
		inFlight ??= mintBounded().finally(() => {
			inFlight = undefined;
		});
		try {
			return await inFlight;
		} catch (err) {
			if (cached && now() < cached.expiresOnTimestamp) return cached;
			throw err;
		}
	};
}
