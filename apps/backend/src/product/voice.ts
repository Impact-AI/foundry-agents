import type { ProductTurn, ProductVoice } from "@platform/agent";
import {
	afterToolRule,
	liveVoiceAudio,
	SPOKEN_DELIVERY,
} from "@platform/voice";
import { locales } from "./locales";
import { surfaceBlock } from "./surface";

/**
 * The live voice: a
 * Foundry voice agent the person talks to, holding the assistant's own
 * prompt for the `live` surface in the spoken register and every tool that
 * surface has, so who the assistant is and what it can do are written once,
 * for both channels. The person's language reaches what is said through the
 * third part, which states it last.
 */

/** The voice agent's name in the project, beside the assistant's. */
const VOICE_AGENT_ID = "assistant-voice";

export function productVoice(surface: string): ProductVoice {
	return {
		agentId: VOICE_AGENT_ID,
		surface,
		languages: locales,
		audio: liveVoiceAudio,
	};
}

/** The live surface's part two: the stage in the spoken register, the spoken delivery, and the rule around a tool call. */
export function liveBehaviour(turn: Pick<ProductTurn, "enabledTools">): string {
	return [
		surfaceBlock(turn, "spoken"),
		SPOKEN_DELIVERY,
		afterToolRule({ reachAside: false }),
	].join("\n\n");
}
