import { resetRedis } from "./connection";

export class ShiftedReplyError extends Error {
	constructor(command: string, reply: unknown) {
		super(
			`redis ${command} answered ${JSON.stringify(reply)}, which it cannot`,
		);
		this.name = "ShiftedReplyError";
	}
}

/**
 * The client pipelines every command onto one socket and matches replies to
 * commands by arrival order, so a reply nobody consumed shifts every later
 * answer by one. It is not an error the client notices: the process reads
 * other commands' answers until the connection is dropped. A caller that
 * knows the shape its reply must have can notice, and this is where it does:
 * anything else drops the connection and throws, so the answer is never
 * trusted.
 */
export function checkedReply<T>(
	command: string,
	reply: unknown,
	expected: (reply: unknown) => reply is T,
): T {
	if (expected(reply)) return reply;
	resetRedis(`${command} answered ${JSON.stringify(reply)}`);
	throw new ShiftedReplyError(command, reply);
}

export const isOkOrNil = (reply: unknown): reply is "OK" | null =>
	reply === "OK" || reply === null;

export const isStringOrNil = (reply: unknown): reply is string | null =>
	typeof reply === "string" || reply === null;
