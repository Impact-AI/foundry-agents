import { setProviderFetch } from "../provider-fetch";

export interface RecordedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	/** The JSON body, or `{}` for a body that is not one — multipart, SDP, none. */
	body: Record<string, unknown>;
	/** The request as sent, for `.json()`, `.text()` or `.formData()`. */
	request: Request;
}

export type Answer = (request: RecordedRequest) => Response | Promise<Response>;

function jsonBody(body: RequestInit["body"]): Record<string, unknown> {
	if (typeof body !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(body);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Route the provider's requests to `answer`, recording each one. */
export function recordRequests(answer: Answer): {
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	setProviderFetch(async (input, init) => {
		// A client fetches a `data:` URL once to learn what this runtime's fetch
		// can carry; it is a question about the runtime, not a provider request.
		if (String(input).startsWith("data:")) return fetch(input, init);
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		const recorded: RecordedRequest = {
			method: init?.method ?? "GET",
			url: String(input),
			headers,
			body: jsonBody(init?.body),
			request: new Request(String(input), {
				method: init?.method,
				headers: init?.headers,
				body: init?.body,
			}),
		};
		requests.push(recorded);
		return answer(recorded);
	});
	return { requests };
}

/** `recordRequests`, under the name its first callers learned. */
export const fakeAzure = recordRequests;
