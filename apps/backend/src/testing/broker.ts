import type { AgentHost } from "@platform/agent";
import { keyNamespace } from "@platform/redis";
import { VoiceBroker } from "@platform/voice";

/**
 * For a test of the app that opens no live session: a broker with no voice
 * agent behind it, so the capability offers none, a start is refused
 * `unconfigured`, and nothing is dialled.
 */
export function idleBroker(host: AgentHost): VoiceBroker {
	return new VoiceBroker({
		host,
		namespace: keyNamespace("idle-broker"),
		endpoint: () => {
			throw new Error("no voice agent in this test");
		},
		token: async () => "unused",
		enabled: false,
		surface: "live",
	});
}
