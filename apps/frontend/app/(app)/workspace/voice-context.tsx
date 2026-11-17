"use client";

import { createContext, useContext } from "react";
import type { VoiceCapability } from "@/src/backend/voice";
import type { Outbox } from "@/src/chat/send-queue";
import type { Stage } from "@/src/stage/stage";
import type { StageToolBrief } from "@/src/stage/tool-briefs";
import type { StageToolHandlers } from "@/src/stage/tools";

/**
 * The voice channel as the composer reaches it: whether it is open, what
 * the server has, and what a live session needs to drive the stage — the
 * same handlers the typed tools run, and the stage to report. The composer
 * is a module-scope slot, so this travels as a context.
 */
export interface VoiceChannel {
	open: boolean;
	setOpen: (open: boolean) => void;
	/**
	 * Whether a live session still holds the thread: from its opening until
	 * its words are written, which is after the pane has closed. A typed turn
	 * sent meanwhile is refused, so every way of sending one waits for this.
	 */
	held: boolean;
	/** A session taking the thread (`true`) or letting it go; each take is let go once. */
	hold: (held: boolean) => void;
	/** Where a chip's or an opener's words go: the composer's column while it is there. */
	outbox: Outbox;
	capability: VoiceCapability;
	locale: string;
	threadId: string;
	handlers: StageToolHandlers;
	briefs: readonly StageToolBrief[];
	stage: Stage;
}

const VoiceContext = createContext<VoiceChannel | null>(null);

export const VoiceProvider = VoiceContext.Provider;

export function useVoiceChannel(): VoiceChannel | null {
	return useContext(VoiceContext);
}
