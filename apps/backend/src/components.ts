/**
 * The components a deployer chooses at deploy time, and which of them go
 * together. A component is which Azure or Foundry piece does a job (where
 * memory is kept, where history is kept, what answers a search, what answers
 * a live session); tuning stays in App Configuration only.
 *
 * Each component is an azd variable (`MEMORY_STORE` …) that reaches the
 * migrate job, whose settings step seeds it as the field's value when the
 * document is absent. The variable is the starting value only: the document
 * stays the operator's to edit later, so an existing document is never
 * overwritten, and a field that differs from its variable is a warning
 * (`settings.component_differs`).
 *
 * One table, {@link RULES}, says which choices go together. The migrate job
 * reads it for the variables and for the stored documents; the hooks
 * (`hooks/preprovision.sh`, `.ps1`) carry the same rules and the same
 * messages, before anything is provisioned, and `hooks/preprovision.test.ts`
 * runs every rule here through them so the two cannot drift. The backend's
 * run-time guards (`memoryStoreFor`, `retrievalEngine`) stay for an edit made
 * after a deploy.
 */
import {
	type AgentSettings,
	HISTORY_STORES,
	MEMORY_STORES,
	VOICE_ENGINES,
} from "@platform/agent";
import { envFlag } from "@platform/config";
import { type KnowledgeSettings, RETRIEVAL_ENGINES } from "@platform/knowledge";

export interface Component {
	/** The azd variable, also the container's environment variable. */
	variable: string;
	/** The settings document and the field it seeds. */
	document: "agent" | "knowledge";
	field: string;
	values: readonly string[];
	/** Read off the documents the job has, to compare and to check. */
	stored: (documents: StoredComponents) => string;
}

export interface StoredComponents {
	agent: AgentSettings;
	knowledge: KnowledgeSettings;
}

export const COMPONENTS: readonly Component[] = [
	{
		variable: "MEMORY_STORE",
		document: "agent",
		field: "memory.store",
		values: MEMORY_STORES,
		stored: (d) => d.agent.memory.store,
	},
	{
		variable: "HISTORY_STORE",
		document: "agent",
		field: "history.store",
		values: HISTORY_STORES,
		stored: (d) => d.agent.history.store,
	},
	{
		variable: "VOICE_ENGINE",
		document: "agent",
		field: "voice.engine",
		values: VOICE_ENGINES,
		stored: (d) => d.agent.voice.engine,
	},
	{
		variable: "RETRIEVAL_ENGINE",
		document: "knowledge",
		field: "retrieval.engine",
		values: RETRIEVAL_ENGINES,
		stored: (d) => d.knowledge.retrieval.engine,
	},
];

/** A set of choices by variable name; a missing one is not chosen. */
export type Choices = Partial<Record<string, string>>;

/** What the deployment is, as the infrastructure made it. */
export interface Deployment {
	/** `PRIVATE_NETWORKING`, as `HARDENED` resolves it. */
	private: boolean;
}

export interface Rule {
	code: string;
	refuses: (choices: Choices, deployment: Deployment) => boolean;
	/** One line, the same in the hooks; no quotes, so a shell carries it as is. */
	message: string;
}

/**
 * Every combination refused. A rule is here only when the code or Microsoft's
 * documentation says the pair cannot work; a combination the code falls back
 * from on its own (speech-to-speech with no realtime deployment, a knowledge
 * base under access control, a reasoning effort with no planning model) is a
 * warning where it happens, not a rule.
 */
export const RULES: readonly Rule[] = [
	{
		// Learn, What is memory?, Limitations: "Virtual network (VNet) integration isn't supported for memory stores."
		code: "agent.memory.store_unreachable_private",
		refuses: (c, d) => d.private && c.MEMORY_STORE === "foundry",
		message:
			"agent.memory.store_unreachable_private: memory.store is foundry on a private deployment (PRIVATE_NETWORKING), where the Foundry memory store extraction calls the account from public Microsoft addresses and is refused 403; Microsoft documents that VNet integration is not supported for memory stores. Set MEMORY_STORE=own (azd env set MEMORY_STORE own), and memory.store to own in the app/agent document if it exists.",
	},
];

/** The line for a variable whose value is not one of its component's. */
function unknownValueMessage(component: Component, value: string): string {
	return `components.unknown_value: ${component.variable} is ${value}, which is not one of ${component.values.join(", ")}. Set it to one of them, or unset it for the default.`;
}

/** What this process's environment says the deployment is. */
export function deploymentFromEnv(): Deployment {
	return {
		private: envFlag("PRIVATE_NETWORKING"),
	};
}

/** The components the azd variables chose; an unset one is left out. */
export function choicesFromEnv(): Choices {
	const out: Choices = {};
	for (const component of COMPONENTS) {
		const value = (process.env[component.variable] ?? "").trim();
		if (value) out[component.variable] = value;
	}
	return out;
}

/** The components the stored documents hold, by variable name. */
export function choicesFromDocuments(documents: StoredComponents): Choices {
	return Object.fromEntries(
		COMPONENTS.map((c) => [c.variable, c.stored(documents)]),
	);
}

/** Every refusal the choices meet, as the lines a deploy prints. */
export function refusals(choices: Choices, deployment: Deployment): string[] {
	const out: string[] = [];
	for (const component of COMPONENTS) {
		const value = choices[component.variable];
		if (value !== undefined && !component.values.includes(value))
			out.push(unknownValueMessage(component, value));
	}
	for (const rule of RULES)
		if (rule.refuses(choices, deployment)) out.push(rule.message);
	return out;
}

/** Throws every refusal as one error, so the job's step, and the deploy, fails. */
export function assertCompatible(
	choices: Choices,
	deployment: Deployment,
): void {
	const found = refusals(choices, deployment);
	if (found.length > 0) throw new Error(found.join("\n"));
}

/** The warning for a stored field that is not what its variable says. */
function differsMessage(
	component: Component,
	variable: string,
	stored: string,
): string {
	return `settings.component_differs: ${component.variable} is ${variable} but the app/${component.document} document's ${component.field} is ${stored}; the document is kept, and the backend runs ${stored}. The variable seeds only an absent document.`;
}

/** Every field whose stored value is not what the deploy's variable chose. */
export function differences(
	choices: Choices,
	documents: StoredComponents,
): string[] {
	const out: string[] = [];
	for (const component of COMPONENTS) {
		const chosen = choices[component.variable];
		const stored = component.stored(documents);
		if (chosen !== undefined && chosen !== stored)
			out.push(differsMessage(component, chosen, stored));
	}
	return out;
}
