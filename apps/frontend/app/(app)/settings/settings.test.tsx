import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthMode } from "@platform/identity/claims";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { draftOf, type PersonDraft } from "@/src/person";
import type { Send } from "@/src/route-call";
import messages from "../../../messages/en.json";
import { TextSizeSelect } from "../../components/TextSizeSelect";
import { MemoryView } from "./MemoryCard";
import {
	editing,
	type MemoryEditing,
	reading,
	removeItem,
	saveDraft,
} from "./memory-editing";
import {
	forgetMemory,
	removeMemoryItem,
	saveMemoryItem,
	savePerson,
} from "./person-calls";
import { YouFields } from "./YouCard";

/**
 * The You section as markup, with no DOM: what each card shows clean,
 * changed and empty, and the calls its buttons make. The state between
 * them is a draft and what was saved, so drawing both is drawing the card.
 */

const html = (node: React.ReactElement) =>
	renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
			{node}
		</NextIntlClientProvider>,
	);
/** A catalogue line as the markup carries it. */
const escaped = (text: string) => text.replaceAll("'", "&#x27;");
const you = messages.settings.you;
const memory = messages.settings.memory;
const nothing = () => {};

const saved: PersonDraft = draftOf({
	name: "Ada",
	about: "I collect maps.",
	preferences: null,
});

function youCard(draft: PersonDraft, signIn: AuthMode = "entra"): string {
	return html(
		<YouFields
			saved={saved}
			draft={draft}
			signIn={signIn}
			onChange={nothing}
			onSave={nothing}
			onCancel={nothing}
		/>,
	);
}

function memoryCard(state: MemoryEditing, confirming = false): string {
	return html(
		<MemoryView
			state={state}
			confirming={confirming}
			onEdit={nothing}
			onChange={nothing}
			onSave={nothing}
			onCancel={nothing}
			onRemove={nothing}
			onForget={nothing}
			onForgetCancel={nothing}
			onForgetConfirm={nothing}
		/>,
	);
}

const NAME = {
	id: "mem_1",
	content: "Goes by Ada.",
	updatedAt: "2026-10-21T10:00:00Z",
};
const MAPS = {
	id: "mem_2",
	content: "Collects <old> maps & charts.",
	updatedAt: "2026-10-20T10:00:00Z",
};
const filled = reading([NAME, MAPS]);

/** A server render has no document; an earlier file's stub must not make it one. */
let savedDocument: PropertyDescriptor | undefined;
beforeAll(() => {
	savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	delete (globalThis as { document?: unknown }).document;
});
afterAll(() => {
	if (savedDocument)
		Object.defineProperty(globalThis, "document", savedDocument);
});

describe("the You card", () => {
	test("clean, it is the three fields and no Save or Cancel", () => {
		const out = youCard(saved);
		expect(out).toContain(`>${you.heading}</h2>`);
		expect(out).toContain('value="Ada"');
		expect(out).toContain("I collect maps.</textarea>");
		expect(out).toContain(you.preferences);
		expect(out).not.toContain(`>${you.save}</button>`);
		expect(out).not.toContain(`>${you.cancel}</button>`);
		expect(out).not.toContain("language");
	});

	test("changed, Save and Cancel appear; whitespace alone is no change", () => {
		const out = youCard({ ...saved, preferences: "Answer briefly." });
		expect(out).toContain(`>${you.save}</button>`);
		expect(out).toContain(`>${you.cancel}</button>`);
		expect(youCard({ ...saved, name: " Ada " })).not.toContain(
			`>${you.save}</button>`,
		);
	});

	test("a blank name says so and cannot be saved", () => {
		const out = youCard({ ...saved, name: "  " });
		expect(out).toContain(you.nameRequired);
		expect(out).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save</);
	});

	test("the name says the Microsoft sign-in fills it, only in entra mode", () => {
		const entra = youCard(saved, "entra");
		expect(entra).toContain(`>${you.nameHint}</span>`);
		expect(entra).toMatch(/<input[^>]*aria-describedby="[^"]*-hint"[^>]*>/);
		expect(youCard(saved, "local")).not.toContain(you.nameHint);
	});
});

describe("what the assistant remembers", () => {
	test("empty, it says nothing is remembered and offers nothing to forget", () => {
		const out = memoryCard(reading([]));
		expect(out).toContain(escaped(memory.empty));
		expect(out).not.toContain(memory.forget);
		expect(out).not.toContain("<li");
	});

	test("read, each statement is a row with its date and its two actions, the text as written and never as markup", () => {
		const out = memoryCard(filled);
		expect(out).toContain("<p>Goes by Ada.</p>");
		expect(out).toContain("<p>Collects &lt;old&gt; maps &amp; charts.</p>");
		expect(out).toContain("Updated Oct 21, 2026");
		expect(out).toContain('aria-label="Edit: Goes by Ada."');
		expect(out).toContain(
			'aria-label="Remove: Collects &lt;old&gt; maps &amp; charts."',
		);
		expect(out).toContain(`>${memory.forget}</button>`);
		expect(out).not.toContain("<textarea");
	});

	test("editing one, its field holds the statement and Save waits for a change that says something; the rest cannot be touched meanwhile", () => {
		const open = editing(filled, NAME.id);
		const clean = memoryCard(open);
		expect(clean).toContain(">Goes by Ada.</textarea>");
		expect(clean).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save</);
		expect(clean).toMatch(
			/aria-label="Remove: Collects[^"]*" disabled=""|disabled=""[^>]*aria-label="Remove: Collects/,
		);
		const changed = memoryCard({
			...open,
			editing: { id: NAME.id, draft: "Goes by Ada, never Adeline." },
		});
		expect(changed).toMatch(/<button type="submit" class="[^"]*">Save</);
		const blank = memoryCard({
			...open,
			editing: { id: NAME.id, draft: "  " },
		});
		expect(blank).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save</);
	});

	test("forgetting asks first", () => {
		const out = memoryCard(filled, true);
		expect(out).toContain('role="alertdialog"');
		expect(out).toContain(memory.forgetHeading);
		expect(out).toContain(`>${memory.forgetCancel}</button>`);
	});
});

describe("the text size", () => {
	test("the rung the cookie names is on in the server's markup, as in the browser's", () => {
		const out = html(<TextSizeSelect labelledBy="h" initial={130} />);
		expect(out).toMatch(/data-scale="130" data-on=""/);
		expect(out).toMatch(/checked="" value="130"/);
		expect(out).not.toMatch(/data-scale="100" data-on/);
	});
});

/** A route that records what it was asked and answers as told. */
function route(answer: () => Response) {
	const calls: { url: string; init: RequestInit }[] = [];
	const send: Send = async (url, init) => {
		calls.push({ url, init });
		return answer();
	};
	return { calls, send };
}

describe("correcting and removing", () => {
	const edited = {
		...editing(filled, NAME.id),
		editing: { id: NAME.id, draft: "Goes by Ada, never Adeline." },
	};

	test("Cancel is a transition, not a call: the card reads the list as before", () => {
		expect(reading(edited.items)).toEqual(filled);
	});

	test("a Save with nothing changed, or nothing said, asks nothing", async () => {
		const r = route(() => Response.json({}));
		expect(await saveDraft(editing(filled, NAME.id), r.send)).toEqual({
			state: editing(filled, NAME.id),
		});
		const blank = { ...edited, editing: { id: NAME.id, draft: " " } };
		expect(await saveDraft(blank, r.send)).toEqual({ state: blank });
		expect(r.calls).toHaveLength(0);
	});

	test("Save PATCHes the statement and puts what was kept first", async () => {
		const kept = {
			...NAME,
			content: "Goes by Ada, never Adeline.",
			updatedAt: "2026-10-23T10:00:00Z",
		};
		const r = route(() => Response.json(kept));
		expect(await saveDraft(edited, r.send)).toEqual({
			state: reading([kept, MAPS]),
		});
		expect(r.calls[0]).toMatchObject({
			url: "/api/me/memory/mem_1",
			init: { method: "PATCH" },
		});
		expect(JSON.parse(String(r.calls[0]?.init.body))).toEqual({
			content: "Goes by Ada, never Adeline.",
		});
	});

	test("a refused Save keeps the draft and answers the code", async () => {
		const r = route(() =>
			Response.json({ code: "unauthenticated" }, { status: 401 }),
		);
		expect(await saveDraft(edited, r.send)).toEqual({
			state: edited,
			code: "unauthenticated",
		});
	});

	test("Remove DELETEs the statement and drops it, gone already included; a refusal keeps it", async () => {
		const gone = route(() => new Response(null, { status: 204 }));
		expect(await removeItem(filled, MAPS.id, gone.send)).toEqual({
			state: reading([NAME]),
		});
		expect(gone.calls[0]).toMatchObject({
			url: "/api/me/memory/mem_2",
			init: { method: "DELETE" },
		});
		const already = route(() =>
			Response.json({ code: "not_found" }, { status: 404 }),
		);
		expect(await removeItem(filled, MAPS.id, already.send)).toEqual({
			state: reading([NAME]),
		});
		const refused = route(() =>
			Response.json({ code: "unauthenticated" }, { status: 401 }),
		);
		expect(await removeItem(filled, MAPS.id, refused.send)).toEqual({
			state: filled,
			code: "unauthenticated",
		});
	});
});

describe("the cards' calls", () => {
	test("saving the person PATCHes only what changed and answers the saved person", async () => {
		const person = { name: "Ada", about: null, preferences: "Briefly." };
		const r = route(() => Response.json(person));
		expect(await savePerson({ preferences: "Briefly." }, r.send)).toEqual({
			person,
		});
		expect(r.calls[0]?.url).toBe("/api/me");
		expect(r.calls[0]?.init.method).toBe("PATCH");
		expect(JSON.parse(String(r.calls[0]?.init.body))).toEqual({
			preferences: "Briefly.",
		});
	});

	test("a statement is addressed by its id, escaped; forgetting DELETEs them all; a refusal is its code", async () => {
		const saved = route(() => Response.json(NAME));
		expect(await saveMemoryItem("mem/1?x", "Goes by Ada.", saved.send)).toEqual(
			{ item: NAME },
		);
		expect(saved.calls[0]?.url).toBe("/api/me/memory/mem%2F1%3Fx");
		const removed = route(() => new Response(null, { status: 204 }));
		expect(await removeMemoryItem("mem_1", removed.send)).toEqual({});
		const gone = route(() => new Response(null, { status: 204 }));
		expect(await forgetMemory(gone.send)).toEqual({});
		expect(gone.calls[0]).toMatchObject({
			url: "/api/me/memory",
			init: { method: "DELETE" },
		});
		const refused = route(() =>
			Response.json({ code: "unauthenticated" }, { status: 401 }),
		);
		expect(await forgetMemory(refused.send)).toEqual({
			code: "unauthenticated",
		});
	});
});
