/**
 * How an Azure SDK says "no such thing", "not yours to do" and "somebody
 * else wrote first": a
 * `statusCode` on the thrown error, the same across App Configuration, Key
 * Vault and Blob.
 */
function statusOf(err: unknown): number | undefined {
	return (err as { statusCode?: number } | null)?.statusCode;
}

export function isNotFound(err: unknown): boolean {
	return statusOf(err) === 404;
}

/** The write collides with one in flight or already applied. */
export function isConflict(err: unknown): boolean {
	return statusOf(err) === 409;
}

/** The caller's identity holds no role that allows the operation. */
export function isForbidden(err: unknown): boolean {
	return statusOf(err) === 403;
}

/** A conditional write refused: the etag no longer matches, or the key already exists. */
export function isPreconditionFailed(err: unknown): boolean {
	const status = statusOf(err);
	return status === 412 || status === 409;
}
