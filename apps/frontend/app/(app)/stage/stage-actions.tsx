"use client";

import { createContext, useContext } from "react";
import type { MediaItem, RecordKind, Section } from "@/src/stage/stage";

/**
 * What a tile, a card in the thread or the landing may ask of the stage,
 * from however deep it is drawn: show the library, open a document, show a
 * record, list the records, chart a record's measure, enlarge a picture,
 * turn a page, close a section, post a turn. One context, so a press on a
 * library card reaches the same road the assistant's tool takes.
 */
export interface StageActions {
	/** The library on the stage, every document: what the tool does when asked for it. */
	showLibrary: () => void;
	openDocument: (id: string) => void;
	showRecord: (kind: RecordKind, id: string) => void;
	/** The records on the stage, every one: what the tool does when asked for them. */
	showRecords: () => void;
	/** One of a record's measures on the chart: what `metrics` then `showChart` does. */
	showMeasure: (kind: RecordKind, id: string, measure: string) => void;
	enlarge: (item: MediaItem) => void;
	turnPage: (page: number) => void;
	close: (section: Section) => void;
	/** Post words as the person's own turn, exactly as typing them would. */
	ask: (text: string) => void;
}

const NONE: StageActions = {
	showLibrary: () => {},
	openDocument: () => {},
	showRecord: () => {},
	showRecords: () => {},
	showMeasure: () => {},
	enlarge: () => {},
	turnPage: () => {},
	close: () => {},
	ask: () => {},
};

const StageActionsContext = createContext<StageActions>(NONE);

export const StageActionsProvider = StageActionsContext.Provider;

export function useStageActions(): StageActions {
	return useContext(StageActionsContext);
}
