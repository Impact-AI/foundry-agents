import { relayLogo } from "@/src/backend/appearance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The deployment's logo, relayed from the backend's public
 * `GET /appearance/logo`: public here too, because the sign-in door draws it.
 * The relay and its bounds are {@link relayLogo}.
 */
export function GET(req: Request): Promise<Response> {
	return relayLogo(req);
}
