import { expect, test } from "bun:test";

/**
 * Every string in the `ai` block is rendered by something.
 *
 * The block is the Article 50(1) disclosure, written as four strings because
 * "first interaction" happens at four places: the door, the conversation's
 * first line, under the composer, and on the voice pane. A catalogue key
 * with no call site is invisible to the type system, to the linter and to
 * catalogue parity — a surface deleted the way one was once never wired is
 * noticed only by a regulator. This cannot see a `display: none`; it can see
 * a missing call site.
 */
const HERE = new URL(".", import.meta.url).pathname;

const SURFACES: Record<string, { file: string; what: string }> = {
	door: {
		file: "app/login/LoginForm.tsx",
		what: "the door, before anyone is inside",
	},
	first: {
		file: "app/(app)/chat/MessageView.tsx",
		what: "the head of the thread, above the conversation's first turn",
	},
	disclosure: {
		file: "app/(app)/chat/Composer.tsx",
		what: "under the composer, for as long as there is a composer",
	},
	voice: { file: "app/(app)/voice/VoicePane.tsx", what: "the voice pane" },
};

async function catalogueKeys(): Promise<string[]> {
	const en = (await Bun.file(`${HERE}messages/en.json`).json()) as {
		ai?: Record<string, unknown>;
	};
	return Object.keys(en.ai ?? {});
}

/** The namespace binding's name is read out of the file rather than assumed. */
async function rendersKey(file: string, key: string): Promise<boolean> {
	const source = await Bun.file(`${HERE}${file}`).text();
	const bindings = [
		...source.matchAll(/const\s+(\w+)\s*=\s*useTranslations\("ai"\)/g),
	].map((m) => m[1]);
	return bindings.some((name) =>
		new RegExp(`\\b${name}\\("${key}"\\)`).test(source),
	);
}

test("every string in the `ai` block has a surface named for it", async () => {
	expect(Object.keys(SURFACES).sort()).toEqual((await catalogueKeys()).sort());
});

for (const [key, { file, what }] of Object.entries(SURFACES)) {
	test(`ai.${key} is rendered at ${what}`, async () => {
		expect(await rendersKey(file, key)).toBe(true);
	});
}

test("every face of the voice pane says the voice is generated: the session, and the pane with no voice behind it", async () => {
	const source = await Bun.file(`${HERE}app/(app)/voice/VoicePane.tsx`).text();
	const panes = source.match(/className="voice-pane"/g) ?? [];
	const notices = source.match(/\btAi\("voice"\)/g) ?? [];
	expect(panes.length).toBeGreaterThan(0);
	expect(notices.length).toBe(panes.length);
});

test("no second copy of the disclosure lives outside the `ai` block", async () => {
	const en = (await Bun.file(`${HERE}messages/en.json`).json()) as Record<
		string,
		unknown
	>;
	const ai = Object.values((en.ai ?? {}) as Record<string, string>);
	const elsewhere: string[] = [];
	const walk = (value: unknown, path: string) => {
		if (typeof value === "string") {
			if (ai.includes(value)) elsewhere.push(path);
		} else if (value && typeof value === "object") {
			for (const [k, child] of Object.entries(value))
				walk(child, path ? `${path}.${k}` : k);
		}
	};
	for (const [k, v] of Object.entries(en)) if (k !== "ai") walk(v, k);
	expect(elsewhere).toEqual([]);
});
