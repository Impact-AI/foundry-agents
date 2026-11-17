import { expect, test } from "bun:test";
import { languageOf } from "./language";
import {
	guardrails,
	KNOWLEDGE_SEARCH,
	LIST_RECORDS,
	LOOKUP_RECORD,
	locales,
	METRICS,
	product,
	SURFACES,
	WEB_SEARCH,
} from "./product";

test("the guardrails render the shipped words, and a slot is retuned but never emptied", () => {
	const shipped = guardrails.render();
	expect(shipped).toContain(guardrails.defaults.scope);
	expect(shipped).toContain("- anything illegal, dangerous or hateful;");
	expect(shipped).not.toContain("being heard");
	expect(guardrails.render("spoken")).toContain("being heard");

	const retuned = guardrails.render("written", {
		scope: "You help the night shift.",
	});
	expect(retuned).toContain("You help the night shift.");
	expect(retuned).toContain(guardrails.defaults.declines[0] as string);

	expect(guardrails.render("written", { scope: "" })).toContain(
		guardrails.defaults.scope,
	);
});

test("the locales are the product's five, and the language is the one the frontend resolved, else English — never a person's own", () => {
	expect(locales.codes).toEqual(["en", "it", "es", "fr", "de"]);
	expect(languageOf(locales, new Headers({ "accept-language": "it" }))).toEqual(
		{
			code: "it",
			name: "Italian",
		},
	);
	expect(
		languageOf(locales, new Headers({ "accept-language": "it-CH,it;q=0.9" })),
	).toEqual({ code: "it", name: "Italian" });
	expect(languageOf(locales, new Headers())).toEqual({
		code: "en",
		name: "English",
	});
	expect(
		languageOf(locales, new Headers({ "accept-language": "xx" })).code,
	).toBe("en");
});

test("the tools follow the operator's switches, and the surface block says which are on in the surface's register", () => {
	const all = { surface: SURFACES.web };
	expect(product.toolKeys).toEqual([
		KNOWLEDGE_SEARCH,
		WEB_SEARCH,
		LOOKUP_RECORD,
		LIST_RECORDS,
		METRICS,
	]);
	// The backend runs every key but web search, which the service runs inside the response.
	expect(
		Object.keys(product.tools({ ...all, enabledTools: product.toolKeys })),
	).toEqual(product.toolKeys.filter((key) => key !== WEB_SEARCH));
	expect(
		Object.keys(product.tools({ ...all, enabledTools: [WEB_SEARCH, METRICS] })),
	).toEqual([METRICS]);
	const none = product.behaviour({ ...all, enabledTools: [] });
	expect(none).toContain("`showLibrary`");
	expect(none).not.toContain(KNOWLEDGE_SEARCH);
	expect(
		product.behaviour({ ...all, enabledTools: [KNOWLEDGE_SEARCH] }),
	).toContain(`your first act is \`${KNOWLEDGE_SEARCH}\``);
	expect(
		product.behaviour({ surface: SURFACES.live, enabledTools: [] }),
	).toContain("hears your voice");
});
