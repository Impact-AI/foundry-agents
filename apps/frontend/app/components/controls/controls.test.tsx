import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./Button";
import { Chip, Tag } from "./Chip";
import { Dialog } from "./Dialog";
import { IconButton } from "./IconButton";
import { IconClose } from "./icons";
import { Menu } from "./Menu";
import { StatusLine } from "./StatusLine";
import { SelectField, TextArea, TextField } from "./TextField";

/**
 * Every control primitive says what it is to assistive technology: a
 * button by its words or its label, a field by a label tied to it, a
 * dialog by its heading, a status by its role. Rendered to markup with no
 * DOM, because the name is in the markup or it is nowhere.
 */
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

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

describe("the controls name themselves", () => {
	test("a button carries its words", () => {
		const out = html(<Button variant="primary">Continue</Button>);
		expect(out).toContain(">Continue</button>");
		expect(out).toContain('type="button"');
		expect(out).toContain("btn--primary");
	});

	test("an icon button carries its label for a reader and for a hover", () => {
		const out = html(
			<IconButton label="Close the sheet">
				<IconClose />
			</IconButton>,
		);
		expect(out).toContain('aria-label="Close the sheet"');
		expect(out).toContain('title="Close the sheet"');
		expect(out).toContain('aria-hidden="true"');
	});

	test("a text field, a text area and a select are each tied to their label", () => {
		for (const out of [
			html(<TextField label="Your name" name="name" hint="Keep using it" />),
			html(<TextArea label="About you" name="about" />),
			html(
				<SelectField label="Language" name="locale">
					<option value="en">English</option>
				</SelectField>,
			),
		]) {
			const id = out.match(/<label for="([^"]+)"/)?.[1];
			expect(id).toBeString();
			expect(out).toContain(`id="${id}"`);
		}
	});

	test("a field's hint and error are read with the control", () => {
		const out = html(
			<TextField label="Name" name="name" hint="A hint" error="Too long" />,
		);
		const describedBy = out.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
		expect(describedBy.split(" ")).toHaveLength(2);
		expect(out).toContain('role="alert"');
	});

	test("a field in error says so on the control, where a reader looks", () => {
		const out = html(<TextField label="Name" name="name" error="Too long" />);
		expect(out).toMatch(/<input[^>]*aria-invalid="true"/);
		expect(out).toMatch(/<div class="form-field">/);
		expect(
			html(<TextField label="Name" name="name" hint="A hint" />),
		).not.toContain("aria-invalid");
	});

	test("a hidden label stays in the markup", () => {
		const out = html(<TextField label="Conversation" hideLabel name="c" />);
		expect(out).toContain('class="sr-only">Conversation</label>');
	});

	test("a chip is a button with its words; a tag is a word", () => {
		expect(html(<Chip on>Library</Chip>)).toContain(
			'aria-pressed="true">Library</button>',
		);
		expect(html(<Tag>people</Tag>)).toContain('class="tag">people</span>');
	});

	test("a menu's opener says a menu follows", () => {
		const out = html(
			<Menu
				label="Account"
				items={[{ key: "a", label: "Settings", onSelect: () => {} }]}
				trigger={({ props }) => (
					<button type="button" aria-label="Account" {...props}>
						AQ
					</button>
				)}
			/>,
		);
		expect(out).toContain('aria-haspopup="menu"');
		expect(out).toContain('aria-expanded="false"');
	});

	test("a dialog is named by its heading, or by its label", () => {
		const named = html(
			<Dialog heading="Delete this account?" onClose={() => {}}>
				<p>Everything goes.</p>
			</Dialog>,
		);
		const id = named.match(/aria-labelledby="([^"]+)"/)?.[1];
		expect(id).toBeString();
		expect(named).toContain(`<h2 id="${id}">Delete this account?</h2>`);
		expect(named).toContain('aria-modal="true"');
		const labelled = html(
			<Dialog label="Camera" onClose={() => {}}>
				<p>Preview</p>
			</Dialog>,
		);
		expect(labelled).toContain('aria-label="Camera"');
	});

	test("a status line is polite, and a danger is announced", () => {
		expect(html(<StatusLine tone="live">Listening</StatusLine>)).toContain(
			'role="status"',
		);
		expect(html(<StatusLine tone="danger">Cut off</StatusLine>)).toContain(
			'role="alert"',
		);
	});
});
