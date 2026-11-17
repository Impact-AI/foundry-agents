/** Canned provider answers, in the shapes the provider parses. */

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A finished Responses API answer of one text part: a completion's body, a stream's last event. */
export function completedResponse(
	text: string,
	usage = { inputTokens: 10, outputTokens: 3 },
): Record<string, unknown> {
	return {
		id: "resp_1",
		created_at: 0,
		model: "deployment",
		output: [
			{
				type: "message",
				role: "assistant",
				id: "msg_1",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		],
		incomplete_details: null,
		usage: {
			input_tokens: usage.inputTokens,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: usage.outputTokens,
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
}

/** A Responses API completion the provider parses into one text part. */
export function completion(
	text: string,
	usage = { inputTokens: 10, outputTokens: 3 },
): Response {
	return json(completedResponse(text, usage));
}

/** A provider refusal, with the headers a throttled call carries. */
export function refusal(status: number, headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify({ error: { message: `HTTP ${status}` } }),
		{
			status,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}
