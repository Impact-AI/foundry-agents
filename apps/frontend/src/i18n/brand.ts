import type { AppearanceSettings } from "@platform/appearance";

type Catalogue = Record<string, Record<string, unknown>>;

/**
 * A language's catalogue with the deployment's name and welcome line put in,
 * where it set them: the name is the app's name (`common.appName`) and the
 * page's title (`metadata.title`), the welcome line the workspace's heading
 * (`landing.heading`). An empty one leaves the catalogue's — so a deployment
 * that set nothing reads exactly as shipped, and no component knows either
 * exists. The AI disclosures are never touched: they say what the assistant
 * is whatever it is called.
 */
export function withBrand<M extends Catalogue>(
	messages: M,
	brand: AppearanceSettings["brand"],
	locale: string,
): M {
	const name = brand.name[locale];
	const welcome = brand.welcome[locale];
	const out: Catalogue = { ...messages };
	if (name) {
		out.common = { ...messages.common, appName: name };
		out.metadata = { ...messages.metadata, title: name };
	}
	if (welcome) out.landing = { ...messages.landing, heading: welcome };
	return out as M;
}
