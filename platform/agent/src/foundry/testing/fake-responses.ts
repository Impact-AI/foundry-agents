import {
	type FakeState,
	type FoundryAnswer,
	HttpError,
	isSearchContextSize,
	metadataOf,
	mintId,
	ok,
	page,
	type Route,
	type SeenTurn,
	seconds,
	text,
} from "./fake-state";

/**
 * The OpenAI-compatible surface the project serves at `/openai/v1`, as the
 * backend uses it: streamed responses on an agent version, in one of two
 * shapes and never a mix of them —
 *
 *   - `store: false` and no conversation, each given its whole history as
 *     input: nothing is kept between requests (a thread on the own store);
 *   - `store: true` in a conversation, given only what is new: the
 *     conversation's items are what the model reads first, and the input
 *     and the output join it once the response completes (a thread on the
 *     service's conversations).
 *
 * A response that asks to be kept without a conversation, names a
 * conversation without asking to be kept, or chains on a previous
 * response is refused, so a change that drifts between the two fails
 * here. The conversations take items in twenties, a function output only
 * for a call still open, list newest or oldest first with `after`, and
 * delete an item, a conversation or a response; whatever an API delete
 * removes is still in `state.retained`, as the service's run state keeps
 * it until its time to live runs out.
 */

const V1 = "/openai/v1";
/** The service takes at most this many items in one create. */
const APPEND_MAX = 20;
/** What the service refuses beside an agent reference: the version decides them. */
const REFUSED_WITH_AGENT = [
	"instructions",
	"tools",
	"model",
	"temperature",
	"top_p",
	"text",
	"reasoning",
];
type Item = Record<string, unknown>;

/**
 * Input items as the service reads them, each checked: a message of a role
 * it takes, with words or pictures; a call the model made earlier and its
 * output, which must follow it; the model's earlier reasoning, which only
 * its encrypted content can stand for. Words given as a string become one
 * text part. Every call must have its output by the end of the input.
 */
function readInput(
	state: FakeState,
	items: unknown,
	open = new Set<string>(),
	{ allAnswered = true } = {},
): Item[] {
	if (!Array.isArray(items))
		throw new HttpError(400, "input is a list of items");
	const read = items.map((raw) => {
		const item = (raw ?? {}) as Item;
		// Only reasoning is given back under the id the service gave it; anything else naming one is refused.
		if ("id" in item && item.type !== "reasoning")
			throw new HttpError(
				400,
				"an input item names an id the service does not hold (store is false)",
			);
		if (item.type === "function_call") {
			if (
				typeof item.call_id !== "string" ||
				typeof item.name !== "string" ||
				typeof item.arguments !== "string"
			)
				throw new HttpError(
					400,
					"a function call has its id, name and arguments",
				);
			open.add(item.call_id);
			return { ...item };
		}
		if (item.type === "reasoning") {
			if (
				typeof item.encrypted_content !== "string" ||
				typeof item.id !== "string" ||
				!item.id.startsWith("rs")
			)
				throw new HttpError(
					400,
					"The provided data does not match the expected schema: reasoning is given back by its id and encrypted content",
				);
			return { ...item };
		}
		if (item.type === "function_call_output") {
			const callId = String(item.call_id);
			if (!open.has(callId))
				throw new HttpError(
					400,
					`No tool call found for function call output with call_id ${callId}.`,
				);
			if (typeof item.output !== "string")
				throw new HttpError(400, "a function output is a string");
			open.delete(callId);
			return { type: item.type, call_id: callId, output: item.output };
		}
		if (item.type !== "message" && item.type !== undefined)
			throw new HttpError(
				400,
				`an input item of type ${String(item.type)} is not taken here`,
			);
		const role = item.role;
		if (
			role !== "user" &&
			role !== "assistant" &&
			role !== "system" &&
			role !== "developer"
		)
			throw new HttpError(400, `a message's role is not ${String(role)}`);
		const content =
			typeof item.content === "string"
				? [
						{
							type: role === "assistant" ? "output_text" : "input_text",
							text: item.content,
						},
					]
				: item.content;
		if (!Array.isArray(content) || content.length === 0)
			throw new HttpError(400, "a message has content");
		for (const part of content as Item[])
			if (
				!(part.type === "input_text" && typeof part.text === "string") &&
				!(part.type === "output_text" && typeof part.text === "string") &&
				!(
					part.type === "input_image" &&
					String(part.image_url).startsWith("data:image/")
				)
			)
				throw new HttpError(
					400,
					`a content part of type ${String(part.type)} is not taken here`,
				);
		return {
			id: mintId(state, "msg"),
			type: "message",
			role,
			status: "completed",
			content,
		};
	});
	if (allAnswered && open.size)
		throw new HttpError(
			400,
			`No tool output found for function call ${[...open][0]}.`,
		);
	return read;
}

/** The calls in `items` nobody has answered, by call id. */
function openCallsOf(items: readonly Item[]): Set<string> {
	const open = new Set<string>();
	for (const item of items) {
		if (item.type === "function_call") open.add(String(item.call_id));
		if (item.type === "function_call_output") open.delete(String(item.call_id));
	}
	return open;
}

/**
 * Items as a conversation stores them: messages and function outputs, each
 * given an id of the service's, an output only for a call `open` holds.
 * Unlike a response's input, the calls left open stay open: an output may
 * be added while another call waits for the browser.
 */
function storedItems(state: FakeState, items: unknown, open: Set<string>) {
	if (!Array.isArray(items))
		throw new HttpError(400, "items is a list of items");
	for (const raw of items) {
		const type = (raw as Item | null)?.type;
		if (type !== "message" && type !== "function_call_output")
			throw new HttpError(
				400,
				`an item of type ${String(type)} is not taken here`,
			);
	}
	const read = readInput(state, items, new Set(open), { allAnswered: false });
	return read.map((item) =>
		item.id ? item : { id: mintId(state, "fco"), ...item },
	);
}

function render(template: string, inputs: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
		name in inputs ? (inputs[name] as string) : whole,
	);
}

/** The structured inputs a version declares, each required one present and every one a string. */
function inputsFor(definition: Item, given: unknown): Record<string, string> {
	const declared = (definition.structured_inputs ?? {}) as Record<
		string,
		{ required?: boolean }
	>;
	const values = (given ?? {}) as Record<string, unknown>;
	for (const [name, spec] of Object.entries(declared))
		if (spec.required && typeof values[name] !== "string")
			throw new HttpError(400, `the structured input ${name} is required`);
	for (const [name, value] of Object.entries(values))
		if (!(name in declared) || typeof value !== "string")
			throw new HttpError(
				400,
				`the structured input ${name} is not declared as a string`,
			);
	return values as Record<string, string>;
}

function nextAnswer(state: FakeState, turn: SeenTurn): FoundryAnswer {
	return state.scripted.shift() ?? state.responder?.(turn) ?? state.reply;
}

const USAGE = {
	input_tokens: 10,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens: 3,
	output_tokens_details: { reasoning_tokens: 0 },
	total_tokens: 13,
};

/**
 * The answer as the service streams it; its reasoning carries its encrypted
 * content when asked for. `completed` is handed the output as the response
 * completes, for a conversation to keep.
 */
function streamed(
	state: FakeState,
	responseId: string,
	answer: Exclude<FoundryAnswer, { blocked: string } | { status: number }>,
	encrypted: boolean,
	completed?: (output: Item[]) => void,
): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: Item) =>
				controller.enqueue(
					encoder.encode(
						`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
					),
				);
			const pace = answer.pace ?? {};
			const word = async () => {
				if (pace.wordMs) await Bun.sleep(pace.wordMs);
			};
			if (pace.beforeMs) await Bun.sleep(pace.beforeMs);
			const response = {
				id: responseId,
				object: "response",
				status: "in_progress",
				created_at: seconds(),
			};
			send({ type: "response.created", response });
			const output: Item[] = [];
			const done = (item: Item) => {
				send({
					type: "response.output_item.done",
					output_index: output.length,
					item,
				});
				output.push(item);
			};
			if (answer.reasoning?.length) {
				const id = mintId(state, "rs");
				send({
					type: "response.output_item.added",
					output_index: output.length,
					item: { type: "reasoning", id, summary: [] },
				});
				for (const [summary_index, part] of answer.reasoning.entries()) {
					send({
						type: "response.reasoning_summary_part.added",
						item_id: id,
						summary_index,
						part: { type: "summary_text", text: "" },
					});
					for (const delta of part.match(/\S+\s*/g) ?? [part]) {
						await word();
						send({
							type: "response.reasoning_summary_text.delta",
							item_id: id,
							summary_index,
							delta,
						});
					}
					send({
						type: "response.reasoning_summary_part.done",
						item_id: id,
						summary_index,
						part: { type: "summary_text", text: part },
					});
				}
				done({
					type: "reasoning",
					id,
					summary: answer.reasoning.map((t) => ({
						type: "summary_text",
						text: t,
					})),
					...(encrypted ? { encrypted_content: `enc:${id}` } : {}),
				});
			}
			if ("calls" in answer) {
				if (answer.text) {
					const id = mintId(state, "msg");
					send({
						type: "response.output_item.added",
						output_index: output.length,
						item: { type: "message", id, role: "assistant", content: [] },
					});
					send({
						type: "response.output_text.delta",
						item_id: id,
						output_index: output.length,
						content_index: 0,
						delta: answer.text,
					});
					done({
						type: "message",
						id,
						role: "assistant",
						status: "completed",
						content: [
							{ type: "output_text", text: answer.text, annotations: [] },
						],
					});
				}
				for (const call of answer.calls) {
					const item = {
						type: "function_call",
						id: mintId(state, "fc"),
						call_id: call.id,
						name: call.name,
						arguments: JSON.stringify(call.args),
						status: "completed",
					};
					send({
						type: "response.output_item.added",
						output_index: output.length,
						item: { ...item, arguments: "" },
					});
					send({
						type: "response.function_call_arguments.delta",
						item_id: item.id,
						output_index: output.length,
						delta: item.arguments,
					});
					done(item);
				}
			} else {
				if (answer.web) {
					const search = {
						type: "web_search_call",
						id: mintId(state, "ws"),
						status: "completed",
					};
					send({
						type: "response.output_item.added",
						output_index: output.length,
						item: { ...search, status: "in_progress" },
					});
					done(search);
				}
				const id = mintId(state, "msg");
				send({
					type: "response.output_item.added",
					output_index: output.length,
					item: { type: "message", id, role: "assistant", content: [] },
				});
				for (const delta of answer.text.match(/\S+\s*/g) ?? [answer.text]) {
					await word();
					send({
						type: "response.output_text.delta",
						item_id: id,
						output_index: output.length,
						content_index: 0,
						delta,
					});
				}
				const annotations = (answer.web ?? []).map((page) => ({
					type: "url_citation",
					url: page.url,
					title: page.title,
					start_index: 0,
					end_index: 0,
				}));
				for (const [annotation_index, annotation] of annotations.entries())
					send({
						type: "response.output_text.annotation.added",
						item_id: id,
						output_index: output.length,
						content_index: 0,
						annotation_index,
						annotation,
					});
				done({
					type: "message",
					id,
					role: "assistant",
					status: answer.filtered ? "incomplete" : "completed",
					content: [{ type: "output_text", text: answer.text, annotations }],
				});
			}
			const filtered = "filtered" in answer && answer.filtered === true;
			// An incomplete response is kept in its conversation as a completed one is.
			completed?.(output);
			send({
				type: filtered ? "response.incomplete" : "response.completed",
				response: {
					...response,
					status: filtered ? "incomplete" : "completed",
					output,
					usage: USAGE,
					incomplete_details: filtered ? { reason: "content_filter" } : null,
				},
			});
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * A response on a deployment with no agent: what a backend's own web search
 * sends (`web-search.ts`). Strict as the agent's are — nothing kept, a
 * stream, the history in the input — and its tools only the service's web
 * search with a context size. Its turn is seen as the model's, `model:<name>`.
 */
function modelResponse(state: FakeState, body: Record<string, unknown>) {
	if (body.store !== false)
		throw new HttpError(400, "this stand-in keeps nothing: store is false");
	if (body.stream !== true) throw new HttpError(400, "this stand-in streams");
	for (const tool of (body.tools ?? []) as Record<string, unknown>[])
		if (tool.type !== "web_search" || !isSearchContextSize(tool))
			throw new HttpError(400, "web_search names a context size");
	const input = readInput(state, body.input);
	const turn: SeenTurn = {
		instructions: String(body.instructions ?? ""),
		items: input,
		input,
		agent: { name: `model:${body.model}`, version: "" },
		body,
	};
	state.turns.push(turn);
	const answer = nextAnswer(state, turn);
	if ("blocked" in answer || "status" in answer)
		throw new HttpError(500, "the stand-in was told to fail");
	return streamed(state, mintId(state, "resp"), answer, false);
}

export function openaiRoutes(state: FakeState): Route[] {
	const conversationOf = (id: string) => {
		const conversation = state.conversations.get(id);
		if (!conversation) throw new HttpError(404, `no conversation ${id}`);
		return conversation;
	};
	const itemsOf = (id: string) => {
		if (!state.items.has(id)) state.items.set(id, []);
		return state.items.get(id) as Item[];
	};

	return [
		{
			method: "POST",
			pattern: new RegExp(`^${V1}/conversations$`),
			handle({ body }) {
				const items = body.items ?? [];
				if (Array.isArray(items) && items.length > APPEND_MAX)
					throw new HttpError(400, `at most ${APPEND_MAX} items`);
				const initial = storedItems(state, items, new Set());
				const id = mintId(state, "conv");
				const conversation = {
					id,
					created_at: seconds(),
					metadata: metadataOf(body.metadata),
				};
				state.conversations.set(id, conversation);
				itemsOf(id).push(...initial);
				return ok({ object: "conversation", ...conversation });
			},
		},
		{
			method: "DELETE",
			pattern: new RegExp(`^${V1}/conversations/([^/]+)$`),
			handle({ match }) {
				const id = match[1] as string;
				conversationOf(id);
				state.conversations.delete(id);
				state.retained.push(...itemsOf(id).splice(0));
				return ok({ id, object: "conversation.deleted", deleted: true });
			},
		},
		{
			method: "POST",
			pattern: new RegExp(`^${V1}/conversations/([^/]+)/items$`),
			handle({ match, body }) {
				const id = match[1] as string;
				conversationOf(id);
				if (
					!Array.isArray(body.items) ||
					body.items.length === 0 ||
					body.items.length > APPEND_MAX
				)
					throw new HttpError(400, `1 to ${APPEND_MAX} items`);
				const added = storedItems(state, body.items, openCallsOf(itemsOf(id)));
				itemsOf(id).push(...added);
				return ok({
					object: "list",
					data: added,
					first_id: added[0]?.id ?? null,
					last_id: added.at(-1)?.id ?? null,
					has_more: false,
				});
			},
		},
		{
			method: "GET",
			pattern: new RegExp(`^${V1}/conversations/([^/]+)/items$`),
			handle({ match, url }) {
				const id = match[1] as string;
				conversationOf(id);
				return page(itemsOf(id), (item) => String(item.id), url, "desc");
			},
		},
		{
			method: "DELETE",
			pattern: new RegExp(`^${V1}/conversations/([^/]+)/items/([^/]+)$`),
			handle({ match }) {
				const [, id, itemId] = match as unknown as [string, string, string];
				const conversation = conversationOf(id);
				const items = itemsOf(id);
				const at = items.findIndex((item) => item.id === itemId);
				if (at < 0) throw new HttpError(404, `no item ${itemId}`);
				state.retained.push(...items.splice(at, 1));
				return ok({ object: "conversation", ...conversation });
			},
		},
		{
			method: "DELETE",
			pattern: new RegExp(`^${V1}/responses/([^/]+)$`),
			handle({ match }) {
				const id = match[1] as string;
				// As the service answers it: a response already gone is a 400 that says so.
				if (!state.responses.delete(id))
					throw new HttpError(400, `${id} not found`);
				return ok({ id, object: "response.deleted", deleted: true });
			},
		},
		{
			method: "POST",
			pattern: new RegExp(`^${V1}/responses$`),
			handle({ body }) {
				if ("agent" in body) throw new HttpError(400, "use agent_reference");
				if (!("agent_reference" in body) && typeof body.model === "string")
					return modelResponse(state, body);
				const reference = body.agent_reference as
					| { type?: string; name?: string; version?: string }
					| undefined;
				if (
					reference?.type !== "agent_reference" ||
					!reference.name ||
					!reference.version
				)
					throw new HttpError(
						400,
						"agent_reference names an agent and its version",
					);
				for (const field of REFUSED_WITH_AGENT)
					if (field in body)
						throw new HttpError(
							400,
							`${field}: Not allowed when agent is specified`,
						);
				if (body.stream !== true)
					throw new HttpError(400, "this stand-in streams");
				const version = state.agents
					.get(reference.name)
					?.find((v) => v.version === reference.version);
				if (!version)
					throw new HttpError(
						404,
						`no version ${reference.version} of agent ${reference.name}`,
					);
				if ("previous_response_id" in body)
					throw new HttpError(
						400,
						"this stand-in chains no responses: the history is the input or the conversation",
					);
				const conversationId =
					"conversation" in body ? text(body, "conversation") : null;
				if (conversationId === null && body.store !== false)
					throw new HttpError(
						400,
						"a response outside a conversation keeps nothing here: store is false",
					);
				if (conversationId !== null) {
					if (body.store !== true)
						throw new HttpError(
							400,
							"a response in a conversation is kept in it: store is true",
						);
					conversationOf(conversationId);
				}
				const before = conversationId ? itemsOf(conversationId) : [];
				const input = readInput(state, body.input, openCallsOf(before)).map(
					(item) =>
						conversationId && !item.id
							? { id: mintId(state, "fco"), ...item }
							: item,
				);
				const instructions = render(
					String(version.definition.instructions ?? ""),
					inputsFor(version.definition, body.structured_inputs),
				);
				const turn: SeenTurn = {
					instructions,
					items: [...before, ...input],
					input,
					agent: { name: reference.name, version: reference.version },
					body,
				};
				state.turns.push(turn);
				const answer = nextAnswer(state, turn);
				if ("blocked" in answer)
					return Response.json(
						{
							error: {
								code: "content_filter",
								message:
									"The response was filtered due to the prompt triggering the content management policy.",
								innererror: {
									code: "ResponsibleAIPolicyViolation",
									content_filter_result: {
										[answer.blocked]: { filtered: true, severity: "high" },
									},
								},
							},
						},
						{ status: 400 },
					);
				if ("status" in answer)
					throw new HttpError(answer.status, "the stand-in was told to fail");
				const include = Array.isArray(body.include) ? body.include : [];
				const responseId = mintId(state, "resp");
				if (conversationId)
					state.responses.set(responseId, {
						id: responseId,
						conversation: conversationId,
					});
				return streamed(
					state,
					responseId,
					answer,
					include.includes("reasoning.encrypted_content"),
					// As the service does: input and output join the conversation once the response completes.
					conversationId
						? (output) => before.push(...input, ...output)
						: undefined,
				);
			},
		},
	];
}
