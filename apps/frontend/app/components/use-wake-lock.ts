"use client";

import { useEffect } from "react";

/**
 * Keep the screen on while a voice channel is open. The lock is released by
 * the platform whenever the page is hidden, so it is re-requested on every
 * return to visibility, and dropped when the channel closes.
 */
type WakeLockNavigator = {
	wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

type WakeLockSentinelLike = {
	release: () => Promise<void>;
	addEventListener?: (type: "release", listener: () => void) => void;
};

type WakeLockDocument = Pick<
	Document,
	"visibilityState" | "addEventListener" | "removeEventListener"
>;

type WakeLockHold = { request: () => void; release: () => void };

function holdWakeLock(
	nav: WakeLockNavigator | null | undefined,
	doc: WakeLockDocument | null | undefined,
): WakeLockHold {
	const api = nav?.wakeLock;
	let sentinel: WakeLockSentinelLike | null = null;
	let pending = false;
	let active = true;
	let generation = 0;

	const request = () => {
		if (!active || !api || sentinel || pending) return;
		if (doc && doc.visibilityState !== "visible") return;
		const mine = ++generation;
		let asked: Promise<WakeLockSentinelLike>;
		try {
			asked = api.request("screen");
		} catch {
			return;
		}
		pending = true;
		void asked
			.then((lock) => {
				if (!active || mine !== generation) {
					void lock.release().catch(() => {});
					return;
				}
				sentinel = lock;
				lock.addEventListener?.("release", () => {
					if (sentinel === lock) sentinel = null;
				});
			})
			.catch(() => {
				// A refused lock is a screen that may dim; the channel still works.
			})
			.finally(() => {
				pending = false;
			});
	};

	const onVisibility = () => {
		if (doc?.visibilityState === "visible") request();
	};
	if (api) doc?.addEventListener("visibilitychange", onVisibility);

	const release = () => {
		if (!active) return;
		active = false;
		generation++;
		if (api) doc?.removeEventListener("visibilitychange", onVisibility);
		const lock = sentinel;
		sentinel = null;
		if (lock) void lock.release().catch(() => {});
	};

	return { request, release };
}

export function useWakeLock(active: boolean): void {
	useEffect(() => {
		if (!active || typeof navigator === "undefined") return;
		const hold = holdWakeLock(
			navigator as unknown as WakeLockNavigator,
			document,
		);
		hold.request();
		return hold.release;
	}, [active]);
}
