"use client";

import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { heldImages } from "@/src/chat/image-store";
import {
	pictureForSlot,
	type SentImage,
	slotKeysIn,
} from "@/src/chat/sent-images";

/**
 * What this browser kept of the thread's pictures, for the slots to draw.
 * Loaded once per thread, refreshed when the keeper writes.
 */
interface Held {
	ready: boolean;
	pictureFor(key: string): SentImage | null;
	refresh(): void;
}

type Loaded = Awaited<ReturnType<typeof heldImages>>;

const HeldImagesContext = createContext<Held>({
	ready: false,
	pictureFor: () => null,
	refresh: () => {},
});

export function HeldImagesProvider({
	threadId,
	children,
}: {
	threadId: string;
	children: React.ReactNode;
}) {
	const { agent } = useAgent({ updates: [UseAgentUpdate.OnMessagesChanged] });
	const [held, setHeld] = useState<Loaded | null>(null);

	const refresh = useCallback(() => {
		void heldImages(threadId).then(setHeld);
	}, [threadId]);

	useEffect(() => {
		setHeld(null);
		refresh();
	}, [refresh]);

	const slotKeys = useMemo(() => slotKeysIn(agent.messages), [agent.messages]);
	const value = useMemo<Held>(
		() => ({
			ready: held !== null,
			pictureFor: (key) =>
				held ? pictureForSlot(held.byKey, held.inOrder, slotKeys, key) : null,
			refresh,
		}),
		[held, slotKeys, refresh],
	);
	return (
		<HeldImagesContext.Provider value={value}>
			{children}
		</HeldImagesContext.Provider>
	);
}

export function useHeldImages(): Held {
	return useContext(HeldImagesContext);
}
