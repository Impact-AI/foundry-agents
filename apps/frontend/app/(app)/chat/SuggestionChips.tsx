"use client";

import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import { planChips } from "@/src/stage/suggestions";
import { uniqueKeys } from "@/src/unique-keys";
import { Chip } from "../../components/controls";
import { useSendTurn } from "../workspace/send-turn";
import { useSuggestions } from "../workspace/suggestions-context";
import { useVoiceChannel } from "../workspace/voice-context";

/**
 * The next steps, always three: the assistant's own, then the catalogue's.
 * Held in place while a turn runs — chips that come and go under the cursor
 * are worse than chips that dim.
 */
export function SuggestionChips({ disabled }: { disabled: boolean }) {
	const t = useTranslations("suggest");
	const { authored, sections } = useSuggestions();
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnMessagesChanged] });
	const voice = useVoiceChannel();
	const direct = useSendTurn(Boolean(voice?.open || voice?.held));
	// Through the column's own rule where there is one: a chip pressed while the thread is busy waits like typed words.
	const send = voice?.outbox.post ?? direct;
	const plan = planChips({
		authored,
		empty: agent.messages.length === 0,
		sections,
	});
	const chips = [...plan.authored, ...plan.keys.map((key) => t(key))];
	if (!chips.length) return null;
	const keys = uniqueKeys(chips);
	return (
		<div className="chat-suggests">
			{chips.map((chip, n) => (
				<Chip
					key={keys[n]}
					className="chat-suggest"
					disabled={disabled}
					onClick={() => send(chip)}
				>
					{chip}
				</Chip>
			))}
		</div>
	);
}
