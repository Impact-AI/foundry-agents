import type {
	AgentHost,
	LiveHistoryLine,
	LiveVoiceOutcome,
	LiveVoiceRequest,
	LiveVoiceSettlement,
	SpokenItem,
} from "@platform/agent";

/**
 * The two host methods the broker calls, stood in for: a binding that names
 * one voice version, one tool of the backend's (`shelf`) and one control
 * of the browser's (`showShelf`), and a settle that records what it was
 * handed and, as the real host does, writes a session once. What the host
 * does with them is the agent's parity suite's to prove; what is proved
 * against this is what the broker hands it.
 */

export const SERVER_TOOL = "shelf";
export const STAGE_TOOL = "showShelf";
export const VOICE_AGENT = "assistant-voice";
const VOICE_VERSION = "1";

interface Settled {
	resourceId: string;
	threadId: string;
	sessionId: string;
	spoken: readonly SpokenItem[];
}

export function stubHost(
	options: {
		/** The version the binding names first. */
		version?: string;
		/** The version made again, for a handshake the service refused. */
		reensuredTo?: string;
		/** The thread so far, given to every session. */
		history?: readonly LiveHistoryLine[];
		/** Bind to Voice Live on this model in place of the voice agent: the session is told everything in its update. */
		voiceLive?: { model: string };
		/** Responses one turn may ask for with the backend's answers. */
		maxSteps?: number;
	} = {},
) {
	const bound: LiveVoiceRequest[] = [];
	const settled: Settled[] = [];
	const toolRuns: { name: string; args: string }[] = [];
	const refusals = new Map<string, LiveVoiceOutcome>();
	let reensured = 0;

	const host: Pick<AgentHost, "liveVoiceBinding" | "settleLiveVoice"> = {
		async liveVoiceBinding(_resourceId, threadId, request) {
			bound.push(request);
			const refused = refusals.get(threadId);
			if (refused) return refused;
			return {
				kind: "bound",
				binding: {
					agentName: VOICE_AGENT,
					version: options.version ?? VOICE_VERSION,
					maxSteps: options.maxSteps ?? 6,
					structuredInputs: {
						personalization: "<person>someone</person>",
						language: request.locale,
					},
					...(options.voiceLive
						? { runtime: { kind: "voiceLive" as const, ...options.voiceLive } }
						: {}),
					// Voice Live's session is flat, as `voiceLiveSession` writes it; a voice agent's is nested.
					session: options.voiceLive
						? {
								type: "realtime",
								input_audio_transcription: { language: request.locale },
								voice: { name: "a-voice", type: "azure-standard" },
							}
						: {
								type: "realtime",
								audio: {
									input: { transcription: { language: request.locale } },
								},
							},
					tools: {
						inBrowser: (name) => name === STAGE_TOOL,
						onServer: (name) => name === SERVER_TOOL,
						run: async (name, args) => {
							toolRuns.push({ name, args });
							return {
								output: JSON.stringify({ shelf: "the second" }),
								sources: [{ id: "atlas", title: "The Atlas" }],
							};
						},
					},
					reensure: async () => {
						reensured++;
						return options.reensuredTo ?? options.version ?? VOICE_VERSION;
					},
					history: options.history ?? [],
				},
			};
		},
		async settleLiveVoice(resourceId, threadId, settle) {
			const repeated = settled.some((s) => s.sessionId === settle.sessionId);
			if (!repeated) settled.push({ resourceId, threadId, ...settle });
			const said = settle.spoken.filter((item) => item.kind === "said");
			const outcome: LiveVoiceSettlement = {
				written: repeated ? 0 : said.length,
				interrupted: 0,
				skipped: { failed: 0, unsettled: 0, filtered: 0 },
				repeated,
			};
			return outcome;
		},
	};
	return {
		host,
		bound,
		settled,
		toolRuns,
		/** Refuse a binding on this thread with this outcome. */
		refuse(threadId: string, outcome: LiveVoiceOutcome) {
			refusals.set(threadId, outcome);
		},
		reensured: () => reensured,
	};
}
