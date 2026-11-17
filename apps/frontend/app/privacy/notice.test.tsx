import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AuthMode } from "@platform/identity/claims";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import de from "../../messages/de.json";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import fr from "../../messages/fr.json";
import it from "../../messages/it.json";
import { PrivacyNotice } from "./PrivacyNotice";

/**
 * Two claims in the notice depend on how the deployment runs, so they are
 * held to it here: a demo sign-in cannot be erased by its owner once its
 * session ends, and the edge's logs, unlike the app's, carry who asked.
 */
const CATALOGUES = { en, it, es, fr, de };

const html = (locale: keyof typeof CATALOGUES, signIn: AuthMode) =>
	renderToStaticMarkup(
		<NextIntlClientProvider
			locale={locale}
			messages={CATALOGUES[locale]}
			timeZone="UTC"
		>
			<PrivacyNotice conversation={null} signIn={signIn} />
		</NextIntlClientProvider>,
	);

const escaped = (text: string) => text.replaceAll("'", "&#x27;");

test("only a demo sign-in is told it cannot come back to erase what it leaves", () => {
	for (const locale of Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[]) {
		const line = escaped(CATALOGUES[locale].privacy.howLong.local);
		expect(html(locale, "local")).toContain(line);
		expect(html(locale, "entra")).not.toContain(line);
	}
});

test("the logs line names what Front Door keeps, for as long as the workspace keeps it", () => {
	const monitoring = readFileSync(
		new URL("../../../../infra/modules/monitoring.bicep", import.meta.url),
		"utf8",
	);
	const days = monitoring.match(/dataRetention: (\d+)/)?.[1];
	expect(days).toBeDefined();
	expect(en.privacy.kept.logs).toContain("IP address");
	expect(en.privacy.kept.logs).toContain(`for ${days} days`);
	expect(it.privacy.kept.logs).toContain("indirizzo IP");
	expect(it.privacy.kept.logs).toContain(`per ${days} giorni`);
	expect(html("en", "entra")).toContain(escaped(en.privacy.kept.logs));
});

test("the voice line says the audio is kept nowhere, because every session asks the service to store nothing", () => {
	const client = readFileSync(
		new URL(
			"../../../../platform/voice/src/voicelive/client.ts",
			import.meta.url,
		),
		"utf8",
	);
	// The claim rests on the socket's query: change it and this line is untrue.
	expect(client).toContain('store: "false"');
	expect(en.privacy.kept.voice).toContain("never stores the audio");
	expect(en.privacy.kept.voice).toContain("written into the conversation");
	expect(it.privacy.kept.voice).toContain("non salva mai l'audio");
	expect(it.privacy.kept.voice).toContain("scritti nella conversazione");
	expect(html("en", "entra")).toContain(escaped(en.privacy.kept.voice));
});
