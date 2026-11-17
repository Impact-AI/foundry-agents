import { imageKey, type SentImage } from "./sent-images";

/**
 * The browser's own store of the pictures it sent, in IndexedDB, keyed by
 * thread. Nothing here reaches a server. A conversation's pictures go when it
 * is deleted, and all of them on sign-out (`signOutHere`), which is what the
 * privacy notice promises; clearing site data empties it too. Every call
 * fails soft — a browser without the API, a private window that refuses
 * it — and the chat draws an empty slot instead.
 */
const DB_NAME = "sent-images";
const DB_VERSION = 1;
const STORE = "images";
const KEEP_AT_MOST = 200;
const OPEN_TIMEOUT_MS = 2000;

type StoredImage = SentImage & { key: string; threadId: string; at: number };

/**
 * The open database, shared by every call. A failed or slow open is not
 * remembered — the next call tries again — so one bad moment cannot leave
 * the page unable to forget what it holds.
 */
let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	if (opening) return opening;
	const attempt = new Promise<IDBDatabase | null>((resolve) => {
		let settled = false;
		const answer = (db: IDBDatabase | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(giveUp);
			resolve(db);
		};
		const giveUp = setTimeout(() => answer(null), OPEN_TIMEOUT_MS);
		try {
			if (typeof indexedDB === "undefined") return answer(null);
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE)) {
					const store = db.createObjectStore(STORE, { keyPath: "key" });
					store.createIndex("threadId", "threadId");
					store.createIndex("at", "at");
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				// An open that answers after the wait was given up is not used.
				if (settled) return db.close();
				// Another tab forgetting everything must not wait on this one.
				db.onversionchange = () => {
					db.close();
					if (opening === attempt) opening = null;
				};
				answer(db);
			};
			request.onerror = () => answer(null);
			request.onblocked = () => answer(null);
		} catch {
			answer(null);
		}
	});
	opening = attempt;
	void attempt.then((db) => {
		if (!db && opening === attempt) opening = null;
	});
	return attempt;
}

function transact<T>(
	mode: IDBTransactionMode,
	work: (store: IDBObjectStore) => T,
): Promise<Awaited<T> | null> {
	return openDb().then(
		(db) =>
			new Promise<Awaited<T> | null>((resolve) => {
				if (!db) return resolve(null);
				try {
					const tx = db.transaction(STORE, mode);
					const value = work(tx.objectStore(STORE));
					tx.oncomplete = () => resolve(value as Awaited<T>);
					tx.onerror = () => resolve(null);
					tx.onabort = () => resolve(null);
				} catch {
					resolve(null);
				}
			}),
	);
}

/**
 * The conversations deleted while this page was open. The chat of a deleted
 * conversation stays mounted until the page has moved on, and a write from
 * it then would put back what was just forgotten.
 */
const deleted = new Set<string>();

export async function keepSentImages(
	threadId: string,
	images: readonly SentImage[],
): Promise<void> {
	if (!images.length || deleted.has(threadId)) return;
	const at = Date.now();
	let written = 0;
	await transact("readwrite", (store) => {
		const known = store.index("threadId").getAllKeys(threadId);
		known.onsuccess = () => {
			const held = new Set((known.result ?? []).map(String));
			for (const image of images) {
				const key = imageKey(image.messageId, image.index);
				if (held.has(key)) continue;
				store.put({ ...image, key, threadId, at } satisfies StoredImage);
				written += 1;
			}
		};
	});
	if (written > 0) await prune();
}

/** The thread's pictures, keyed and in the order they were kept. */
export async function heldImages(
	threadId: string,
): Promise<{ byKey: Map<string, SentImage>; inOrder: SentImage[] }> {
	const rows = await transact(
		"readonly",
		(store) =>
			new Promise<StoredImage[]>((resolve) => {
				try {
					const request = store.index("threadId").getAll(threadId);
					request.onsuccess = () => resolve(request.result ?? []);
					request.onerror = () => resolve([]);
				} catch {
					resolve([]);
				}
			}),
	);
	const byKey = new Map<string, SentImage>();
	const inOrder: SentImage[] = [];
	for (const row of (rows ?? []).sort((a, b) => a.at - b.at)) {
		if (!row || typeof row.value !== "string") continue;
		const image = {
			messageId: row.messageId,
			index: row.index,
			value: row.value,
			mimeType: row.mimeType,
		};
		byKey.set(row.key, image);
		inOrder.push(image);
	}
	return { byKey, inOrder };
}

async function prune(): Promise<void> {
	await transact("readwrite", (store) => {
		const counter = store.count();
		counter.onsuccess = () => {
			const over = counter.result - KEEP_AT_MOST;
			if (over <= 0) return;
			let dropped = 0;
			const cursor = store.index("at").openCursor();
			cursor.onsuccess = () => {
				const at = cursor.result;
				if (!at || dropped >= over) return;
				at.delete();
				dropped += 1;
				at.continue();
			};
		};
	});
}

/** Forget the pictures one conversation sent from here — the conversation is gone. */
export async function forgetConversationImages(
	threadId: string,
): Promise<void> {
	deleted.add(threadId);
	await transact("readwrite", (store) => {
		const known = store.index("threadId").getAllKeys(threadId);
		known.onsuccess = () => {
			for (const key of known.result ?? []) store.delete(key);
		};
	});
}

/**
 * Forget every picture this browser kept — on sign-out and with the account.
 * The database itself is deleted, which needs no open connection to work:
 * this page's own is closed first, and another tab's closes when asked.
 */
export async function forgetHeldImages(): Promise<void> {
	const held = opening;
	opening = null;
	void held?.then((db) => db?.close());
	if (typeof indexedDB === "undefined") return;
	await new Promise<void>((resolve) => {
		const giveUp = setTimeout(resolve, OPEN_TIMEOUT_MS);
		const done = () => {
			clearTimeout(giveUp);
			resolve();
		};
		try {
			const request = indexedDB.deleteDatabase(DB_NAME);
			request.onsuccess = done;
			request.onerror = done;
		} catch {
			done();
		}
	});
}
