import type { AgentProduct } from "@platform/agent";
import type { LocaleRegistry } from "@platform/i18n";
import type { FileResult, LibraryLoad } from "@platform/knowledge";
import type { PromptSlot } from "@platform/prompt/store";
import type { Hono } from "hono";
import type { AppEnv } from "./auth/context";

/**
 * What a product hands this app beyond what the agent's host reads: the
 * surfaces its turns come from, its languages, the routes of its own it
 * serves, and the library it ships. `product.ts` builds the one object, and
 * no route, job step or wiring names a file of the product's. What the app
 * takes from `product.ts` is the three names of `ProductModule` below and
 * nothing else, so a `product.ts` that exports those three, with a
 * `product/` behind it, replaces the product. The sample's tests and the
 * stand-ins under `testing/` read more of it — its tool names, its media
 * paths — and are replaced with it.
 */
export interface BackendProduct extends AgentProduct {
	/** The surface a typed turn names and the one the live voice session runs on. */
	surfaces: { web: string; live: string };
	/** The languages the product speaks: the one list a request's language is resolved against. */
	locales: LocaleRegistry<string>;
	/**
	 * The product's own routes, mounted on the app behind the caller gate and
	 * the body bound, as every route is. A product decides, on each, whether
	 * it stands behind the standing gate too.
	 */
	routes?(app: Hono<AppEnv>): void;
	/** A library the product ships: what the job's `library` step loads, and removes, when given no name. */
	library?: {
		name: string;
		/** Load it, or another directory under another name through the same steps. */
		load(
			onFile?: (result: FileResult) => void,
			source?: { dir: string; name: string },
		): Promise<LibraryLoad>;
	};
}

/**
 * What `product.ts` exports for the app to read: the object above, the
 * persona's slot — which the job publishes and the persona's step reads —
 * and the guardrail wording the settings documents are seeded with.
 * `product-boundary.test.ts` holds the app's files to these names.
 */
export interface ProductModule {
	product: BackendProduct;
	prompt: PromptSlot;
	guardrails: { defaults: object };
}
