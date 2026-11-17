import type { AgentHost, ThreadView } from "@platform/agent";
import { getAccount } from "@platform/identity";
import { problems } from "./problems";
import { transcriptMessageOf } from "./transcript";

/**
 * The right of access and the right to portability as one file: the
 * account — who the person is, what they wrote about themselves, and what
 * the assistant remembers about them, verbatim — and everything they said,
 * as JSON. Written a fragment at a time, so an account with years of
 * conversations never has to fit in memory at once.
 */
const EXPORT_FORMAT = "personal-data-export/3";

async function* fragments(
	host: AgentHost,
	accountId: string,
): AsyncGenerator<string> {
	const [account, memory] = await Promise.all([
		getAccount(accountId),
		host.readMemory(accountId),
	]);
	const head = {
		format: EXPORT_FORMAT,
		exportedAt: new Date().toISOString(),
		account: account && { ...account, memory: memory.items },
	};
	yield `${JSON.stringify(head).slice(0, -1)},"conversations":[`;
	let first = true;
	for await (const id of threadIds(host, accountId)) {
		const thread = await wholeThread(host, accountId, id);
		if (!thread) continue;
		yield `${first ? "" : ","}${JSON.stringify({
			id: thread.id,
			title: thread.title,
			createdAt: thread.createdAt,
			updatedAt: thread.updatedAt,
			messages: thread.messages.map(transcriptMessageOf),
		})}`;
		first = false;
	}
	yield "]}";
}

/**
 * A conversation with every message in it, oldest first: its pages read
 * from the newest back to its first, never one page's worth of it. One
 * conversation is held at a time. Null when it went meanwhile.
 */
async function wholeThread(
	host: AgentHost,
	accountId: string,
	id: string,
): Promise<ThreadView | null> {
	const newest = await host.readThread(accountId, id);
	if (!newest) return null;
	const pages = [newest.messages];
	for (let before = newest.earlier; before; ) {
		const older = await host.readThread(accountId, id, { before });
		if (!older) return null;
		pages.unshift(older.messages);
		before = older.earlier;
	}
	return { ...newest, messages: pages.flat(), earlier: null };
}

/**
 * Every conversation's id, page by page to the last. Newest first, so one
 * the person writes to while the copy is made moves to the front and its
 * page's neighbours shift back a row: seen ids are skipped, not repeated.
 */
async function* threadIds(
	host: AgentHost,
	accountId: string,
): AsyncGenerator<string> {
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await host.listThreads(accountId, { cursor });
		for (const { id } of page.threads) {
			if (seen.has(id)) continue;
			seen.add(id);
			yield id;
		}
		cursor = page.next ?? undefined;
	} while (cursor);
}

/**
 * The copy as a download. A read that fails once the answer has begun
 * cannot change its status: the stream is errored, so the person's download
 * fails rather than ending as a file that looks whole, and the failure is
 * reported for the operator, since no route's error handler sees it.
 */
export function exportResponse(host: AgentHost, accountId: string): Response {
	const chunks = fragments(host, accountId);
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { value, done } = await chunks.next();
					if (done) controller.close();
					else controller.enqueue(encoder.encode(value));
				} catch (err) {
					console.error("[backend] an export stopped part way:", err);
					problems.report("backend.export.incomplete", { status: 200 });
					controller.error(err);
				}
			},
			cancel() {
				void chunks.return(undefined);
			},
		}),
		{
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Content-Disposition": 'attachment; filename="my-data.json"',
				"Cache-Control": "no-store",
			},
		},
	);
}
