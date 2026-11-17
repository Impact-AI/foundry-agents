/**
 * Is this replica serving? Deliberately the dumbest possible answer: the
 * process is up and Next can run a route. Nothing about the backend or the
 * identity provider — a probe that checked a downstream would turn "the
 * backend is slow" into "restart every replica". Public: the proxy's matcher
 * excludes it, because a probe carries no session.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
	return Response.json(
		{ status: "ok", app: "frontend" },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
