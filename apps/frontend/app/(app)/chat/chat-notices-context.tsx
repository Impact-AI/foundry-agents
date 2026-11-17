"use client";

import { createContext, useContext } from "react";

/**
 * What the column has to say that is not a turn: a picture that could not
 * be attached, and a read behind the stage that failed — by its code, since
 * the column is on every layout and the stage is not. Read where the
 * composer stands, because a notice belongs where the person is looking.
 */
export interface ChatNotices {
	rejected: string | null;
	dismissRejected: () => void;
	stageProblem: string | null;
	dismissStageProblem: () => void;
}

const NONE: ChatNotices = {
	rejected: null,
	dismissRejected: () => {},
	stageProblem: null,
	dismissStageProblem: () => {},
};

const ChatNoticesContext = createContext<ChatNotices>(NONE);

export const ChatNoticesProvider = ChatNoticesContext.Provider;

export function useChatNotices(): ChatNotices {
	return useContext(ChatNoticesContext);
}
