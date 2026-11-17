"use client";

import {
	CopilotChatReasoningMessage,
	type CopilotChatReasoningMessageProps,
} from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import {
	advance,
	type ReasoningClock,
	type ReasoningLabel,
	type ReasoningTurn,
	reasoningLabel,
	reasoningTurns,
	type ThreadMessage,
} from "@/src/chat/reasoning";
import { IconChevronRight } from "../../components/controls";
import { Markdown } from "../../components/markdown/Markdown";
import "./thinking.css";
import "./reasoning.css";

interface ReasoningState {
	turns: Map<string, ReasoningTurn>;
	clocks: Map<string, ReasoningClock>;
	open: ReadonlySet<string>;
	toggle: (key: string) => void;
}

const ReasoningContext = createContext<ReasoningState | null>(null);

/**
 * Kept beside the module rather than in a component, so a thread drawn
 * again — the pager moving, the column remounting — still knows how long a
 * turn it watched spent reasoning.
 */
const clocks = new Map<string, ReasoningClock>();

/**
 * The thread's reasoning, read once for every part: which turn each belongs
 * to, how long each turn has spent, which disclosures are open. The runtime
 * draws each part through a memoised slot that re-renders for its own
 * message alone; the slot reads this context, which reaches it whenever any
 * part of the turn changes.
 */
export function ReasoningProvider({
	messages,
	isRunning,
	children,
}: {
	messages: readonly ThreadMessage[];
	isRunning: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = useCallback(
		(key: string) =>
			setOpen((was) => {
				const next = new Set(was);
				if (!next.delete(key)) next.add(key);
				return next;
			}),
		[],
	);
	const turns = useMemo(
		() => reasoningTurns(messages, isRunning),
		[messages, isRunning],
	);
	// The clock is read in the same render the streaming flag flips, so the
	// label never shows a stale "Thinking…"; advancing twice is a no-op.
	const now = Date.now();
	for (const turn of new Set(turns.values()))
		clocks.set(turn.key, advance(clocks.get(turn.key), turn.streaming, now));
	const value = useMemo(
		() => ({ turns, clocks, open, toggle }),
		[turns, open, toggle],
	);
	return (
		<ReasoningContext.Provider value={value}>
			{children}
		</ReasoningContext.Provider>
	);
}

function useLabel(): (label: ReasoningLabel) => string {
	const t = useTranslations("reasoning");
	return (label) =>
		label.key === "seconds" || label.key === "minutes"
			? t(label.key, { count: label.count })
			: t(label.key);
}

/**
 * The runtime's reasoning slot. Every part of a turn is handed here; the
 * turn's latest draws its one disclosure and the others draw nothing.
 */
function ReasoningPart({ message }: CopilotChatReasoningMessageProps) {
	const state = useContext(ReasoningContext);
	const say = useLabel();
	const turn = state?.turns.get(message.id);
	if (!state || !turn || turn.drawnAt !== message.id) return null;
	return (
		<ReasoningView
			id={`reasoning-${turn.key}`}
			label={say(reasoningLabel(turn.streaming, state.clocks.get(turn.key)))}
			summary={turn.summary}
			streaming={turn.streaming}
			open={state.open.has(turn.key)}
			onToggle={() => state.toggle(turn.key)}
		/>
	);
}

/**
 * One line that opens on the reasoning's summary, closed until asked. The
 * summary is in the page only while it is open; a turn whose reasoning
 * carried no words is the line alone, with nothing to open.
 */
export function ReasoningView({
	id,
	label,
	summary,
	streaming,
	open,
	onToggle,
}: {
	id: string;
	label: string;
	summary: string;
	streaming: boolean;
	open: boolean;
	onToggle: () => void;
}) {
	const live = streaming ? "" : undefined;
	if (!summary)
		return (
			<p className="reasoning reasoning-label" data-streaming={live}>
				{label}
			</p>
		);
	return (
		<div className="reasoning" data-streaming={live}>
			<button
				type="button"
				id={`${id}-toggle`}
				className="reasoning-toggle"
				aria-expanded={open}
				aria-controls={`${id}-summary`}
				onClick={onToggle}
			>
				<span className="reasoning-label">{label}</span>
				<IconChevronRight className="reasoning-chevron" />
			</button>
			<section
				id={`${id}-summary`}
				className="reasoning-summary"
				aria-labelledby={`${id}-toggle`}
				hidden={!open}
			>
				{open ? <Markdown source={summary} under={3} /> : null}
			</section>
		</div>
	);
}

// A slot replacement must carry the original's statics to satisfy its type.
export const ReasoningMessage = Object.assign(
	ReasoningPart,
	CopilotChatReasoningMessage,
);
