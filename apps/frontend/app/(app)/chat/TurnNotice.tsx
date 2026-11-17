"use client";

import {
	UseAgentUpdate,
	useAgent,
	useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { readTurnRefusal, wasBlocked } from "@/src/chat/turn-refusal";
import { waitPhrase } from "@/src/chat/wait";
import { Button, StatusLine } from "../../components/controls";

type Notice =
	| { code: string; retryAfter: number }
	| { lost: true }
	| { blocked: true };

/**
 * The one place a broken run is reported, beside the composer it concerns:
 * without it the failure is silent. A refusal says what ran out, in the
 * reader's language; a turn the content filter refused says only that it
 * cannot help; anything else says the answer was cut off.
 */
export function TurnNotice() {
	const t = useTranslations("chat");
	const common = useTranslations("common");
	const errors = useTranslations("errors");
	const { copilotkit } = useCopilotKit();
	const [notice, setNotice] = useState<Notice | null>(null);
	// A new turn starting is the last one's notice answered: it goes, and
	// comes back only if this one breaks too. Cleared on the run's own start
	// event, which comes before anything that run can fail with — clearing
	// on what the page next draws as running could come after a failure
	// that arrived in the same moment, and take it.
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
	useEffect(() => {
		const subscription = agent.subscribe({
			onRunInitialized: () => setNotice(null),
		});
		return () => subscription.unsubscribe();
	}, [agent]);

	useEffect(() => {
		const subscription = copilotkit.subscribe({
			onError: ({ error, code }) => {
				console.error(`[chat] ${code}:`, error);
				setNotice(
					wasBlocked(error)
						? { blocked: true }
						: (readTurnRefusal(error) ?? { lost: true }),
				);
			},
		});
		return () => subscription.unsubscribe();
	}, [copilotkit]);

	if (!notice) return null;
	let line: string;
	if ("blocked" in notice) line = t("blocked");
	else if ("lost" in notice) line = t("runLost");
	else if (notice.code === "rate_limited" || notice.code === "pool_exhausted") {
		const wait = waitPhrase(notice.retryAfter);
		line = t(notice.code === "rate_limited" ? "refused" : "refusedPool", {
			wait: t(`wait.${wait.key}`, { count: wait.count }),
		});
	} else line = errors(notice.code);
	return (
		<StatusLine
			tone="danger"
			action={
				<Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
					{common("dismiss")}
				</Button>
			}
		>
			{line}
		</StatusLine>
	);
}
