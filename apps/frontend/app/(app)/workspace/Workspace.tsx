"use client";

import { useTranslations } from "next-intl";
import {
	lazy,
	Suspense,
	useCallback,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import type {
	ConversationSummary,
	TranscriptMessage,
} from "@/src/backend/conversations";
import type { VoiceCapability } from "@/src/backend/voice";
import { createOutbox } from "@/src/chat/send-queue";
import { measureNames } from "@/src/stage/measure-names";
import {
	type MediaItem,
	type RecordKind,
	reduceStage,
	type Section,
	type Stage,
} from "@/src/stage/stage";
import type { StageToolBrief } from "@/src/stage/tool-briefs";
import { chartMeasure, stageToolHandlers } from "@/src/stage/tools";
import { useRegisterStageControls } from "../../components/stage-controls";
import { ChatColumn } from "../chat/ChatColumn";
import { useBringAcross } from "../stage/bring-across";
import { GuidedLanding } from "../stage/GuidedLanding";
import { StageAnnouncer } from "../stage/StageAnnouncer";
import { StagePages } from "../stage/StagePages";
import { StagePanel } from "../stage/StagePanel";
import {
	type StageActions,
	StageActionsProvider,
} from "../stage/stage-actions";
import { useStageHistory } from "../stage/stage-history";
import { RunStartWatcher } from "./RunStartWatcher";
import { StageContext } from "./StageContext";
import { StageTools } from "./StageTools";
import { useSendTurn } from "./send-turn";
import {
	fetchDocument,
	fetchLibrary,
	fetchMetrics,
	fetchRecord,
	fetchRecords,
} from "./stage-fetch";
import { SuggestionsProvider } from "./suggestions-context";
import { VoiceProvider } from "./voice-context";
import "./workspace.css";

const MediaOverlay = lazy(() =>
	import("../stage/MediaOverlay").then((m) => ({ default: m.MediaOverlay })),
);

/**
 * The workspace: the stage on one side, the conversation on the other, and
 * the assistant driving the first from the second. Holds the stage, builds
 * the one set of tool handlers both channels run, registers the briefed
 * tools, publishes the live context, and lends the chrome its controls.
 * Must live inside the runtime.
 */
export function Workspace({
	threadId,
	conversations,
	transcript,
	briefs,
	capability,
	locale,
}: {
	threadId: string;
	conversations: ConversationSummary[];
	transcript: TranscriptMessage[];
	briefs: StageToolBrief[];
	capability: VoiceCapability;
	locale: string;
}) {
	const t = useTranslations("workspace");
	const tRecord = useTranslations("record");
	const [stage, dispatch] = useReducer(reduceStage, [] as Stage);
	const [authored, setAuthored] = useState<string[]>([]);
	const [enlarged, setEnlarged] = useState<MediaItem | null>(null);
	const [voiceOpen, setVoiceOpen] = useState(false);
	// Counted, not flagged: a reopened session takes the thread before the one it replaces lets go.
	const [voiceHolds, setVoiceHolds] = useState(0);
	const holdVoice = useCallback(
		(held: boolean) => setVoiceHolds((n) => Math.max(0, n + (held ? 1 : -1))),
		[],
	);
	const pager = useRef<HTMLElement>(null);
	// Words that are not typed — a chip, an opener — go where typed ones do
	// while the column is on the page, and wait there when they must.
	const direct = useSendTurn(voiceOpen || voiceHolds > 0);
	const directNow = useRef(direct);
	directNow.current = direct;
	const outbox = useMemo(
		() => createOutbox((text) => directNow.current(text)),
		[],
	);
	const ask = outbox.post;

	// A read behind the stage that failed, by its code; gone once something is placed.
	const [stageProblem, setStageProblem] = useState<string | null>(null);
	const dismissStageProblem = useCallback(() => setStageProblem(null), []);
	const handlers = useMemo(
		() =>
			stageToolHandlers({
				dispatch: (action) => {
					if (action.type === "place") setStageProblem(null);
					dispatch(action);
				},
				failed: setStageProblem,
				library: fetchLibrary,
				document: fetchDocument,
				record: fetchRecord,
				records: fetchRecords,
				suggest: setAuthored,
			}),
		[],
	);

	const home = useCallback(() => {
		dispatch({ type: "clear" });
		setEnlarged(null);
	}, []);
	// What the person opens by hand is brought into view on a phone's pager.
	const byHand = useBringAcross(pager, stage);
	// By hand, the library and the records are the tools' own handlers with
	// no query: everything, as the assistant would show it when asked.
	const showLibrary = useCallback(() => {
		byHand("library", () => void handlers.showLibrary({}));
	}, [handlers, byHand]);
	const showRecords = useCallback(() => {
		byHand("records", () => void handlers.showRecords({}));
	}, [handlers, byHand]);
	const stageUp = stage.length > 0;
	useRegisterStageControls(home, showLibrary, showRecords, stageUp);
	useStageHistory(stageUp, home);

	const actions = useMemo<StageActions>(
		() => ({
			showLibrary,
			openDocument: (id: string) => {
				byHand("reader", () => void handlers.openDocument({ id }));
			},
			showRecord: (kind: RecordKind, id: string) => {
				byHand("record", () => void handlers.showRecord({ kind, id }));
			},
			showRecords,
			showMeasure: (kind: RecordKind, id: string, measure: string) => {
				byHand(
					"chart",
					() =>
						void chartMeasure(
							handlers,
							fetchMetrics,
							kind,
							id,
							measure,
							setStageProblem,
							measureNames(tRecord),
						),
				);
			},
			enlarge: setEnlarged,
			turnPage: (page: number) => dispatch({ type: "page", page }),
			close: (section: Section) => {
				dispatch({ type: "remove", section });
				setEnlarged(null);
			},
			ask,
		}),
		[handlers, showLibrary, showRecords, ask, byHand, tRecord],
	);

	const sections = useMemo(() => stage.map((i) => i.section), [stage]);
	const suggestions = useMemo(
		() => ({ authored, sections }),
		[authored, sections],
	);
	const clearAuthored = useCallback(() => setAuthored([]), []);

	const voice = useMemo(
		() => ({
			open: voiceOpen,
			setOpen: setVoiceOpen,
			held: voiceHolds > 0,
			hold: holdVoice,
			outbox,
			capability,
			locale,
			threadId,
			handlers,
			briefs,
			stage,
		}),
		[
			voiceOpen,
			voiceHolds,
			holdVoice,
			outbox,
			capability,
			locale,
			threadId,
			handlers,
			briefs,
			stage,
		],
	);

	return (
		<StageActionsProvider value={actions}>
			<SuggestionsProvider value={suggestions}>
				<VoiceProvider value={voice}>
					<StageTools briefs={briefs} handlers={handlers} />
					<StageContext stage={stage} />
					<StageAnnouncer stage={stage} />
					<RunStartWatcher onRunStart={clearAuthored} />
					<section
						className={`workspace${stageUp ? " is-staged" : ""}`}
						ref={pager}
						aria-label={t("label")}
					>
						<div className="workspace-main">
							{stageUp ? <StagePanel stage={stage} /> : <GuidedLanding />}
							{enlarged ? (
								<Suspense fallback={null}>
									<MediaOverlay
										item={enlarged}
										onClose={() => setEnlarged(null)}
									/>
								</Suspense>
							) : null}
						</div>
						<ChatColumn
							threadId={threadId}
							conversations={conversations}
							transcript={transcript}
							stageProblem={stageProblem}
							onDismissStageProblem={dismissStageProblem}
						/>
					</section>
					<StagePages stage={stage} pager={pager} />
				</VoiceProvider>
			</SuggestionsProvider>
		</StageActionsProvider>
	);
}
