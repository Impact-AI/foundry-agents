"use client";

import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import { useTranslations } from "next-intl";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type DocumentSource,
	mergeSources,
	readSources,
	sourcesOwner,
} from "@/src/chat/sources";
import { Chip } from "../../components/controls";
import { MediaImage } from "../../components/MediaImage";
import { useStageActions } from "../stage/stage-actions";

/**
 * The documents a reply drew on, under the reply: one chip a document, a
 * press opening it in the reader by the same road a library card takes.
 * The backend sends them once a turn, as a `sources` custom event after
 * the reply's words, so they are read off the run and kept by the message
 * they follow. Kept beside the module rather than in a component, so a
 * thread drawn again — the pager moving, the column remounting — still
 * shows what a reply it watched drew on.
 */
const held = new Map<string, DocumentSource[]>();

const SourcesContext = createContext<{
	/** Counts the events read, so a consumer re-reads the map on each. */
	version: number;
	of: (messageId: string) => DocumentSource[];
}>({ version: 0, of: () => [] });

export function SourcesProvider({ children }: { children: ReactNode }) {
	const [version, setVersion] = useState(0);
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
	useEffect(() => {
		const subscription = agent.subscribe({
			onCustomEvent: ({ event, messages }) => {
				if (event.name !== "sources") return;
				const owner = sourcesOwner(messages);
				const sources = readSources(event.value);
				if (!owner || !sources.length) return;
				held.set(owner, mergeSources(held.get(owner) ?? [], sources));
				setVersion((v) => v + 1);
			},
		});
		return () => subscription.unsubscribe();
	}, [agent]);
	const value = useMemo(
		() => ({
			version,
			of: (messageId: string) => held.get(messageId) ?? [],
		}),
		[version],
	);
	return (
		<SourcesContext.Provider value={value}>{children}</SourcesContext.Provider>
	);
}

/** The chips, drawn from a list: no hook, so a test can read the tree it returns. */
export function SourceChipList({
	label,
	sources,
	onOpen,
}: {
	label: string;
	sources: readonly DocumentSource[];
	onOpen: (id: string) => void;
}) {
	if (!sources.length) return null;
	return (
		<div className="assistant-sources">
			<span className="assistant-sources-label">{label}</span>
			{sources.map((source) => (
				<Chip
					key={source.id}
					className="source-chip"
					data-document-id={source.id}
					onClick={() => onOpen(source.id)}
				>
					{source.thumbnailUrl ? (
						<span className="source-chip-figure" aria-hidden="true">
							<MediaImage src={source.thumbnailUrl} alt="" />
						</span>
					) : null}
					<span className="source-chip-title">{source.title}</span>
				</Chip>
			))}
		</div>
	);
}

/** The sources under one assistant message, when it has any. */
export function SourceChips({ messageId }: { messageId: string }) {
	const t = useTranslations("chat");
	const actions = useStageActions();
	const sources = useContext(SourcesContext).of(messageId);
	return (
		<SourceChipList
			label={t("sources")}
			sources={sources}
			onOpen={actions.openDocument}
		/>
	);
}
