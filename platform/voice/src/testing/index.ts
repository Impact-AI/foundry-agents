/**
 * For tests: the voice agent's socket stood in for at its protocol
 * boundary, a browser's socket driven as the pane drives it, and a verified
 * usage subject minted the way a caller's is. Everything above them — the
 * broker, the ledger, Redis — runs for real.
 */
import { type UsageSubject, usageSubject } from "@platform/metering";

export {
	type BrowserSocketClient,
	openBrowserSocket,
} from "../broker/testing/browser";
export {
	type FakeTurn,
	type FakeVoiceAgentOptions,
	fakeVoiceAgent,
} from "../voicelive/testing/fake-voice-agent";

/** A verified usage subject for a test, minted the way a caller's is. */
export function subject(id: string): UsageSubject {
	const minted = usageSubject(id);
	if (!minted) throw new Error(`"${id}" is not a usage subject`);
	return minted;
}
