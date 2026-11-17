import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { type AttributeBag, scrubAttributes } from "../scrub";

/**
 * The same rules for a log record's attributes. The body is left alone on
 * purpose: it is prose written by whoever wrote the log line, and rewriting it
 * would corrupt the diagnosis without making a guarantee. What keeps a body
 * clean is the rule about what may be logged in the first place; this is the
 * net under it for the structured half.
 */
export class ScrubbingLogRecordProcessor implements LogRecordProcessor {
	onEmit(logRecord: SdkLogRecord): void {
		try {
			scrubAttributes(logRecord.attributes as AttributeBag);
		} catch {
			// A record that cannot be scrubbed loses its attributes rather than
			// keeping unscrubbed ones.
			for (const key of Object.keys(logRecord.attributes)) {
				delete (logRecord.attributes as AttributeBag)[key];
			}
		}
	}

	forceFlush(): Promise<void> {
		return Promise.resolve();
	}

	shutdown(): Promise<void> {
		return Promise.resolve();
	}
}
