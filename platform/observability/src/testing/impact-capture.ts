/**
 * One process, one start of the Impact SDK, as `impact.test.ts` runs it:
 *
 *   bun impact-capture.ts on|off
 *
 * The Bun pipeline with an in-memory exporter where Azure Monitor would be
 * and impact.ai configured to a receiver on this machine, the SDK's capture
 * on as it ships (`on`) or every content category off (`off`). A request
 * calls the Responses API on this machine through the OpenAI client, whole
 * and streamed, as the Foundry agent's turns do. Prints what impact.ai was
 * sent, as text, and the spans Azure Monitor would have got, as JSON.
 */
import {
	InMemorySpanExporter,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import OpenAI from "openai";
import {
	impactCopyRunning,
	startBunTelemetry,
	stopTelemetry,
	withRequestSpan,
} from "../bun";

const mode = process.argv[2];
if (mode !== "on" && mode !== "off") {
	console.error("impact-capture: on or off");
	process.exit(2);
}

const ANSWER = "Fakeville is the capital.";
const QUESTION = "What is the capital of Fakeland?";

const bodies: string[] = [];
const receiver = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		// The protobuf body holds its strings as written.
		bodies.push(Buffer.from(await request.arrayBuffer()).toString("latin1"));
		return new Response(new Uint8Array(0), {
			headers: { "content-type": "application/x-protobuf" },
		});
	},
});

/** One response, whole or streamed as the Responses API streams it. */
const response = (model: string) => ({
	id: "resp_1",
	object: "response",
	created_at: 1,
	status: "completed",
	model,
	output: [
		{
			type: "message",
			id: "msg_1",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: ANSWER, annotations: [] }],
		},
	],
	usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
});
const models = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const body = (await request.json()) as { model: string; stream?: boolean };
		if (!body.stream) return Response.json(response(body.model));
		const done = response(body.model);
		const events = [
			{
				type: "response.created",
				response: { ...done, status: "in_progress", output: [] },
			},
			{
				type: "response.output_text.delta",
				item_id: "msg_1",
				output_index: 0,
				content_index: 0,
				delta: ANSWER,
			},
			{ type: "response.completed", response: done },
		];
		return new Response(
			events
				.map(
					(event, i) =>
						`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`,
				)
				.join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});

const memory = new InMemorySpanExporter();
const exporter: SpanExporter = {
	export: (spans, done) => memory.export(spans, done),
	shutdown: async () => {},
	forceFlush: async () => {},
};

startBunTelemetry({
	serviceName: "assistant-backend",
	release: {
		id: "rel_0123456789abcdef01234567",
		version: "12",
		environment: "development",
		revision: "ca-backend-abc--v12",
	},
	impact: {
		endpoint: `http://127.0.0.1:${receiver.port}/v1/traces`,
		apiKey: "ingest-key",
		...(mode === "off"
			? {
					content: {
						input: false,
						output: false,
						tools: false,
						retrieval: false,
						media: false,
					},
				}
			: {}),
	},
	exporter,
});
const running = await impactCopyRunning();

// Made after the SDK has started, as the backend's start waits for it.
const client = new OpenAI({
	baseURL: `http://127.0.0.1:${models.port}/v1`,
	apiKey: "model-key",
});
const answers: string[] = [];
await withRequestSpan(async () => {
	const whole = await client.responses.create({
		model: "chat",
		input: QUESTION,
	});
	answers.push(whole.output_text);
	const stream = await client.responses.create({
		model: "chat",
		input: `${QUESTION} (streamed)`,
		stream: true,
	});
	for await (const event of stream)
		if (event.type === "response.output_text.delta") answers.push(event.delta);
	return new Response(null, { status: 200 });
})(new Request("http://localhost/api/turn"));
await stopTelemetry();

console.log(
	JSON.stringify({
		running,
		answers,
		sent: bodies.join("").replace(/[^\x20-\x7e]/g, "."),
		azure: memory.getFinishedSpans().map((span) => ({
			name: span.name,
			recorded: JSON.stringify([span.attributes, span.events]),
		})),
	}),
);
receiver.stop(true);
models.stop(true);
process.exit(0);
