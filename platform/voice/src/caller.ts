import type { Tier } from "@platform/identity/claims";
import type { UsageSubject } from "@platform/metering";

/**
 * Who a voice request is for, as the app verified it. Nothing here is read
 * from the request: the subject comes from a verified session, the tier from
 * the database at the point of use, the language from the one resolution
 * order. The broker takes it beside the request and never looks past it.
 */
export interface VoiceLanguage {
	/** A bare language subtag, which is what a stated session pins its transcription to. */
	code: string;
	/** The English name, which is what a model is told. */
	name: string;
}

export interface VoiceCaller {
	subject: UsageSubject;
	tier: Tier;
	language: VoiceLanguage;
	/** Which client surface the request came from, for the usage line. */
	surface?: string | null;
}
