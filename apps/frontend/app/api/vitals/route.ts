import { z } from "zod";
import { readBounded } from "@/src/bounded-body";
import { isOwnOriginRequest } from "@/src/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Field measurement, one line per page view, from the beacon in
 * `app/components/Vitals.tsx`. Bounded before it is parsed, validated before
 * it is logged, and never stored: it is a log line for an operator, with no
 * identifier of a person on it. It asks for no session — the door reports
 * too — so it is taken only from a page of this app, as every other route
 * that writes is, and no answer of its is kept.
 */
const MAX_BYTES = 4096;

const short = z
	.string()
	.max(200)
	.transform((s) => s.slice(0, 120));
const ms = z.number().finite().nonnegative().max(600_000);

const Report = z
	.object({
		path: short,
		ttfb: ms.optional(),
		fcp: ms.optional(),
		inp: ms.optional(),
		inpTarget: short.optional(),
		longFrames: z.number().int().nonnegative().max(100_000).optional(),
		worstFrame: ms.optional(),
		sampled: z.number().int().nonnegative().max(1_000_000).optional(),
		viewport: z.number().int().nonnegative().max(20_000).optional(),
		failures: z.array(short).max(5).optional(),
	})
	.strict();

const answered = (status: number) =>
	new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request): Promise<Response> {
	if (!isOwnOriginRequest(req)) return answered(403);
	let raw: string;
	try {
		const bytes = await readBounded(req, MAX_BYTES);
		if (!bytes) return answered(413);
		raw = new TextDecoder().decode(bytes);
	} catch {
		return answered(204);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return answered(400);
	}
	const result = Report.safeParse(parsed);
	if (!result.success) return answered(400);

	console.log(
		`[vitals] ${JSON.stringify({ ...result.data, ua: (req.headers.get("user-agent") ?? "").slice(0, 160) })}`,
	);
	return answered(204);
}
