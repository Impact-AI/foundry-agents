import {
	AppConfigTimeoutError,
	appConfigAvailable,
	appConfigClient,
	appConfigTimeoutMs,
	type ConfigKey,
	defineConfigKey,
	envFlag,
	isNotFound,
	processSingleton,
	qualifyKey,
	resetSingleton,
	withDeadline,
} from "@platform/config";
import { type DocumentAccess, GLOBAL_ACCESS_GROUP } from "../types";

/**
 * Whether a document is read by who asks, from the operator's `access`
 * document. Its own key rather than a section of `tools`: that document says
 * which tools, recall and skills are on, and is read by the agent host; this one says who may see what, and is read by retrieval and by
 * the library step, so an edit to one cannot flip the other. Two switches,
 * both compiled-in, and both read towards the closed side: a stored switch
 * that is not a boolean enforces and withholds, and a store that is
 * configured and has never answered is an error rather than the default,
 * so neither a slip in the portal nor an outage can open a library.
 */

export const ACCESS_SETTINGS_KEY = "access";

export interface AccessSettings {
	/** Every search carries the caller's readers clause; a search with no caller returns nothing. */
	enforceAccessControl: boolean;
	/**
	 * A document loaded with no declared readers is described as readable by
	 * the group `all`, and `all` is in every caller's clause. Off, such a
	 * document admits nobody under enforcement — those already written as
	 * `all` included, since the clause is where the group is honoured.
	 */
	globalDocumentAccess: boolean;
}

export const DEFAULT_ACCESS_SETTINGS: AccessSettings = {
	enforceAccessControl: false,
	globalDocumentAccess: true,
};

/**
 * A hardened deployment's: readers enforced, and a document nobody declared
 * readers for still everybody's, so a library whose `access.json` opens it
 * to `all` (the sample's) reads as before while one that names readers is
 * held to them.
 */
export const HARDENED_ACCESS_SETTINGS: AccessSettings = {
	enforceAccessControl: true,
	globalDocumentAccess: true,
};

/**
 * The defaults for this deployment: `HARDENED`, the template's flag, picks
 * the hardened ones. The job seeds these, and the memo falls back to them,
 * so a hardened deployment enforces readers unless an operator stores
 * otherwise; a document already stored is never rewritten by a seed.
 */
export function defaultAccessSettings(): AccessSettings {
	return envFlag("HARDENED")
		? HARDENED_ACCESS_SETTINGS
		: DEFAULT_ACCESS_SETTINGS;
}

/**
 * The stored document over `defaults`. A switch that is absent keeps its
 * default; one that is stored as anything but a boolean takes the closed
 * side — enforcement on, global access off — and a document that is not an
 * object closes both, since what the operator meant cannot be told. A
 * document stored as JSON `null` is one of those, which is why the key is
 * read here rather than through the store's reader: that reader answers an
 * absent key and a stored `null` alike.
 */
export function parseAccessSettings(
	stored: unknown,
	defaults: AccessSettings,
): AccessSettings {
	if (typeof stored !== "object" || stored === null || Array.isArray(stored))
		return { enforceAccessControl: true, globalDocumentAccess: false };
	const fields = stored as Record<string, unknown>;
	const read = (name: keyof AccessSettings, closed: boolean): boolean => {
		const value = fields[name];
		if (value === undefined) return defaults[name];
		return typeof value === "boolean" ? value : closed;
	};
	return {
		enforceAccessControl: read("enforceAccessControl", true),
		globalDocumentAccess: read("globalDocumentAccess", false),
	};
}

/** The store is configured and has not answered once: who may read what is not known. */
export class AccessSettingsUnreadError extends Error {
	constructor() {
		super(
			`the "${ACCESS_SETTINGS_KEY}" document has not been read from the store, so who may read a document is not known`,
		);
		this.name = "AccessSettingsUnreadError";
	}
}

const SINGLETON = "knowledge:access-settings";

/** What a stored `null` is read as: not an object, so both switches close. */
const STORED_NULL = "null";

/**
 * The document as stored: null when the key is absent, so the defaults
 * stand; the parsed value otherwise, a stored `null` as {@link STORED_NULL}
 * and text that is not JSON as the text, both of which close the switches.
 */
async function readStored(key: string): Promise<unknown> {
	const timeoutMs = appConfigTimeoutMs();
	let setting: { value?: string | null };
	try {
		setting = await withDeadline(
			(abortSignal) =>
				appConfigClient().getConfigurationSetting(
					{ key: qualifyKey(key) },
					{ abortSignal },
				),
			timeoutMs,
			() => new AppConfigTimeoutError(key, timeoutMs),
		);
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
	if (setting.value == null) return STORED_NULL;
	try {
		return JSON.parse(setting.value) ?? STORED_NULL;
	} catch {
		return setting.value;
	}
}

interface Holder {
	key: ConfigKey<AccessSettings>;
	/**
	 * Every value the origin's answer was read into, a checkout with no store
	 * included. What a read hands back is the store's word only if it is one
	 * of these: the compiled default, served when a read failed with nothing
	 * held, never is.
	 */
	answers: WeakSet<AccessSettings>;
}

/** What an origin with no document, or no origin at all, answers: nothing set, so every switch at its default. */
const NOTHING_STORED = {};

function holder(): Holder {
	return processSingleton(SINGLETON, () => {
		const held: Holder = {
			answers: new WeakSet(),
			key: defineConfigKey<AccessSettings>({
				key: ACCESS_SETTINGS_KEY,
				defaultValue: defaultAccessSettings(),
				// A value of its own for each answer, so it is told from the default by which object it is.
				parse: (stored, defaults) => {
					const answer = { ...parseAccessSettings(stored, defaults) };
					held.answers.add(answer);
					return answer;
				},
				read: async (key) =>
					(appConfigAvailable() ? await readStored(key) : null) ??
					NOTHING_STORED,
			}),
		};
		return held;
	});
}

/**
 * The current settings, through the memo: the last good value over a failed
 * refresh, the default on a checkout with no store. Throws
 * `AccessSettingsUnreadError` while a configured store has never answered,
 * because the default there would be a guess that enforcement is off.
 */
export async function accessSettings(): Promise<AccessSettings> {
	const held = holder();
	const settings = await held.key.read();
	// A read that failed with nothing held hands back the default, which is
	// no answer; so does one whose answer an invalidation overtook and a
	// later read could not replace.
	if (!held.answers.has(settings)) throw new AccessSettingsUnreadError();
	return settings;
}

/** The waits between a load's reads of a store that has not answered. */
const SETTLE_DELAYS_MS = [250, 500, 1_000] as const;

/**
 * The settings for a job's step, which has no later request to try again
 * on: a store that has not answered is asked again after each of
 * `delaysMs`, so one slow first token or one dropped read does not fail a
 * load. A replica's read does not wait: `accessSettings` refuses the
 * request in hand, and a request a fifth of a second later asks the store
 * again.
 */
export async function settledAccessSettings(
	delaysMs: readonly number[] = SETTLE_DELAYS_MS,
): Promise<AccessSettings> {
	for (const delay of delaysMs) {
		try {
			return await accessSettings();
		} catch (err) {
			if (!(err instanceof AccessSettingsUnreadError)) throw err;
			await new Promise((r) => setTimeout(r, delay));
			// The reader paces a failed read; a step that has waited asks at once.
			holder().key.invalidate();
		}
	}
	return accessSettings();
}

/** Forget the memo and its definition, so the next read sees the store afresh. */
export function resetAccessSettings(): void {
	resetSingleton(SINGLETON);
}

/** The readers a document gets when nobody declared any. */
export function defaultDocumentAccess(
	settings: AccessSettings,
): DocumentAccess {
	return {
		oids: [],
		groups: settings.globalDocumentAccess ? [GLOBAL_ACCESS_GROUP] : [],
	};
}
