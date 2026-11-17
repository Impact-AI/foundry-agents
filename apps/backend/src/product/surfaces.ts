/**
 * The interfaces a turn can come from. The surface block and the skills are
 * gated by it. `live` is the voice agent's (`product/voice.ts`): the same
 * assistant, in the spoken register.
 */
export const SURFACES = { web: "web", live: "live" } as const;

/**
 * Where the product's web app serves a picture of the knowledge base: its
 * own route, which relays to this backend's `GET /media/{path}`. The stage
 * is the product's, so the address its cards and tool results carry is
 * named here, once, and a product whose web app serves pictures elsewhere
 * changes this line.
 */
export const STAGE_MEDIA_ROUTE = "/api/media/";
