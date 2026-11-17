/**
 * The persona's own structure: the headings a row is expected to carry, in an
 * order that is the argument (identity before facts before voice before
 * capabilities before reflexes), and a budget, because every turn pays for
 * the whole row. Advisory, with one exception: the section the guardrails
 * name must exist, or their sentence points at nothing.
 */
export interface PersonaSectionSpec {
	heading: string;
	required: boolean;
	purpose: string;
}

export const DEFAULT_PERSONA_SECTIONS: readonly PersonaSectionSpec[] = [
	{
		heading: "CORE IDENTITY",
		required: true,
		purpose:
			"Who the agent is, what it is for, and what it calls the person in front of it. Named by the guardrails, which override it.",
	},
	{
		heading: "WHAT YOU KNOW",
		required: false,
		purpose:
			"The handful of facts it must not get wrong in passing. Everything else it looks up.",
	},
	{
		heading: "HOW YOU SOUND",
		required: false,
		purpose: "Register, humour, length, and what it never does with a reply.",
	},
	{
		heading: "WHAT YOU CAN DO",
		required: false,
		purpose:
			"The shape of its capabilities, in general terms. Which tools exist on a turn is the surface block's job.",
	},
	{
		heading: "HOW YOU WORK",
		required: false,
		purpose:
			"The reflexes: act rather than offer, look before answering, never show the machinery.",
	},
];

export const DEFAULT_PERSONA_BUDGET = 12_000;

export interface PersonaFinding {
	level: "error" | "warning";
	message: string;
}

function headingsOf(text: string): string[] {
	return [...text.matchAll(/^#{1,3}\s+(.+?)\s*$/gm)].map((m) =>
		(m[1] ?? "").trim().toUpperCase(),
	);
}

export function lintPersona(
	text: string,
	options: { sections?: readonly PersonaSectionSpec[]; budget?: number } = {},
): PersonaFinding[] {
	const sections = options.sections ?? DEFAULT_PERSONA_SECTIONS;
	const budget = options.budget ?? DEFAULT_PERSONA_BUDGET;
	const findings: PersonaFinding[] = [];
	const headings = headingsOf(text);

	for (const spec of sections) {
		if (headings.includes(spec.heading.toUpperCase())) continue;
		findings.push({
			level: spec.required ? "error" : "warning",
			message: spec.required
				? `Missing "${spec.heading}". The guardrails name this section as the one they override, so a row without it leaves that sentence pointing at nothing.`
				: `No "${spec.heading}" section. ${spec.purpose}`,
		});
	}

	const template = sections.map((s) => s.heading.toUpperCase());
	const present = headings.filter((h) => template.includes(h));
	const expected = template.filter((h) => present.includes(h));
	if (present.join("|") !== expected.join("|")) {
		findings.push({
			level: "warning",
			message: `Sections are out of the usual order. Expected: ${expected.join(" → ")}.`,
		});
	}

	if (text.length > budget) {
		findings.push({
			level: "warning",
			message: `${text.length.toLocaleString()} characters — over the ${budget.toLocaleString()} this prompt is budgeted for, and every turn pays for all of it. Anything true of one kind of question belongs in a skill; anything the sources already hold, the agent can search for.`,
		});
	}

	if (/https?:\/\/|\bwww\./i.test(text)) {
		findings.push({
			level: "warning",
			message:
				"Contains a URL. The agent is told never to say one out loud, and a link here is a link it may read back.",
		});
	}

	if (/\byou (?:must )?call `?[a-z]+[A-Z][a-zA-Z]*`?/.test(text)) {
		findings.push({
			level: "warning",
			message:
				"Names a specific tool. Which tools exist differs by surface and by turn — the surface block names them.",
		});
	}

	return findings;
}
