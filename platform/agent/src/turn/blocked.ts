/**
 * Whether a failed response was the content filter refusing it, and on what
 * grounds. The service answers a filtered prompt with a 400 whose
 * `error.code` is `content_filter` and whose `innererror` names the
 * categories that tripped; a response filtered on the way out fails, or
 * stops incomplete, with the same code. The categories are for the log and
 * the trace: the person is told only that the turn was blocked.
 */
export interface ContentFilterRefusal {
	/** The categories the filter flagged; empty when the service named none. */
	categories: string[];
}

interface ServiceError {
	code?: unknown;
	innererror?: { content_filter_result?: Record<string, unknown> };
}

/** The error object, from the client's thrown error or as a failed response carries it. */
function serviceErrorOf(error: unknown): ServiceError | null {
	if (!error || typeof error !== "object") return null;
	const nested = (error as { error?: unknown }).error;
	return (
		nested && typeof nested === "object" ? nested : error
	) as ServiceError;
}

export function contentFilterRefusal(
	error: unknown,
): ContentFilterRefusal | null {
	const service = serviceErrorOf(error);
	if (service?.code !== "content_filter") return null;
	const result = service.innererror?.content_filter_result ?? {};
	return {
		categories: Object.entries(result)
			.filter(
				([, verdict]) =>
					!!verdict &&
					typeof verdict === "object" &&
					(verdict as { filtered?: unknown }).filtered === true,
			)
			.map(([category]) => category),
	};
}
