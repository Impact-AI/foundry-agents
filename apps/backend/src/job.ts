import {
	agentSettings,
	historyKeptByService,
	memoryStoreFor,
} from "@platform/agent";
import {
	createFoundryAgentHost,
	ensureMemoryStore,
	reportVoiceEngines,
} from "@platform/agent/foundry";
import { seedConfigDocuments } from "@platform/config";
import { assertDeploymentSafe } from "@platform/config/deployment-guard";
import { closeCosmos, cosmosDeploymentRules } from "@platform/cosmos";
import {
	ensureKnowledgeBase,
	ensurePipeline,
	type FileResult,
	knowledgeSettings,
	type LibraryLoad,
	loadLibrary,
	refillIndex,
	removeLibrary,
	shieldChunks,
	UNENFORCED_READERS,
} from "@platform/knowledge";
import { llmSettings, requireDeployment } from "@platform/llm";
import type { PromptSync } from "@platform/prompt/store";
import { closeRedis } from "@platform/redis";
import {
	assertCompatible,
	choicesFromDocuments,
	choicesFromEnv,
	deploymentFromEnv,
	differences,
} from "./components";
import { configDocuments } from "./config-documents";
import { product, prompt, skills } from "./product";

/**
 * The migrate job's entry: `bun run src/job.ts <step>...`, every step in the
 * order given in one execution, each logged under its name, the first
 * failure failing the execution. The job runs beside the apps, in their
 * network, as its own identity, so nothing a deploy writes into a data
 * plane is written from the deployer's machine.
 *
 *   settings        the components the azd variables chose, refused when
 *                   they cannot go together (`components.ts`); the
 *                   settings documents, written where absent or `{}`, a
 *                   component field seeded from its variable; a warning
 *                   for a stored component that differs from its variable,
 *                   which is kept; a stored combination that cannot work
 *                   refused;
 *                   the persona's first version, where it has none, and
 *                   the next where the shipped text changed and no
 *                   operator has published one
 *   index           AI Search's index, data source, skillset and indexer,
 *                   made or brought up to date — an index that must be
 *                   made again is, and is refilled from the blobs and
 *                   scanned in the same step; the knowledge source and
 *                   base over the index too, when the `knowledge`
 *                   document's `retrieval.engine` is `knowledgeBase`
 *   skills          the product's default skills seeded into Cosmos DB, each
 *                   only where no version of its name is stored
 *   agent           the memory store (preview), made where missing, when the
 *                   `agent` document's `memory.store` is `foundry`; the
 *                   agent version each surface's turns ask for, made before
 *                   traffic does; the voice agent's version (preview) for
 *                   each engine some tier is answered by — speech-to-speech
 *                   falling back to the cascade, under a code, while no
 *                   realtime deployment is configured; all but the newest
 *                   versions of each pruned, every engine's current one
 *                   kept; and, when
 *                   `history.store` is `foundry`, a warning that the
 *                   service keeps what its deletes remove until its time
 *                   to live — never a failure
 *   library                the product's own library, mirrored into the library
 *                          container, then loaded as below
 *   library:<name>         the library uploaded under <name>/: each file
 *                          described in its blob's metadata, the indexer run
 *                          and waited for, what left it pruned, every new
 *                          chunk read by Prompt Shields
 *   remove-library         the product's own library's blobs and chunks deleted
 *   remove-library:<name>  that library's blobs and chunks deleted
 *   shield                 every chunk of every library Prompt Shields has
 *                          not read, read: after an indexer run nobody waited for
 *
 * A deploy runs `settings index skills agent` then `library`, or
 * `remove-library` when the sample is switched off; the ingest script runs
 * `library:<name>`, or `remove-library:<name>` with `--remove`.
 */
export type StepRunner = (argument?: string) => Promise<string>;

/** A library's name in the container: one path segment, as the ingest script checks it too. */
const LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function logFile(result: FileResult): void {
	console.log(
		`[library] ${result.status} ${result.path}${result.detail ? ` — ${result.detail}` : ""}`,
	);
}

/** The load's line; throws when any file failed, so a deploy does not pass with half a library. */
function summary(load: LibraryLoad): string {
	for (const flagged of load.shield.flagged)
		console.warn(
			`[library] Prompt Shields found an attack in ${flagged.path}: that passage is never served`,
		);
	const open =
		load.unenforced > 0
			? `; ${UNENFORCED_READERS}: ${load.unenforced} file(s) name readers that nothing enforces while access.enforceAccessControl is off`
			: "";
	const line = `${load.described} described, ${load.unchanged} unchanged, ${load.skipped} skipped, ${load.failed} failed; the indexer read ${load.indexed} file(s), ${load.pruned} chunk(s) pruned, ${load.shield.scanned} chunk(s) read by Prompt Shields, ${load.shield.flagged.length} flagged, ${load.shield.withheld} left unserved for a later scan${open}`;
	if (load.failed > 0) throw new Error(line);
	return line;
}

/** The settings step's words for what `sync` did to the persona. */
function personaLine(sync: PromptSync): string {
	switch (sync.outcome) {
		case "seeded":
			return `the persona seeded as ${sync.label}`;
		case "unchanged":
			return `the persona ${sync.label} is the shipped text`;
		case "published":
			return `the persona ${sync.label} published: the shipped text changed`;
		case "operator":
			return `the persona ${sync.label} is the operator's${sync.defaultChanged ? "; the shipped text changed and is not published over it" : ""}`;
	}
}

export const STEPS: Record<string, StepRunner> = {
	settings: async () => {
		// The components the azd variables chose, refused before anything is written when they cannot go together.
		const deployment = deploymentFromEnv();
		const chosen = choicesFromEnv();
		assertCompatible(chosen, deployment);
		const written = await seedConfigDocuments(configDocuments());
		// The documents as stored: a variable seeds only an absent one, so an operator's later edit stands, said here when it differs.
		const stored = {
			agent: await agentSettings(),
			knowledge: await knowledgeSettings(),
		};
		for (const line of differences(chosen, stored))
			console.warn(`[settings] ${line}`);
		// An edit since the last deploy that cannot work here fails this deploy; the backend's own guards cover one made after it.
		assertCompatible(choicesFromDocuments(stored), deployment);
		const persona = personaLine(await prompt.sync());
		return [
			written.length > 0
				? `seeded ${written.join(", ")}`
				: "every document already stored",
			persona,
		].join("; ");
	},
	index: async () => {
		const { names, rebuilt } = await ensurePipeline();
		// A rebuilt index is empty: refilled here, since no later step need run the indexer.
		const refill = rebuilt ? await refillIndex() : null;
		const base = await ensureKnowledgeBase();
		return `index "${names.index}", data source, skillset and indexer ensured${refill ? `; the index was rebuilt and refilled: the indexer read ${refill.indexed} file(s), ${refill.failures.length} failed, ${refill.shield.scanned} chunk(s) read by Prompt Shields, ${refill.shield.flagged.length} flagged, ${refill.shield.withheld} left unserved for a later scan` : ""}; ${base.made ? `knowledge base "${base.made}" and its source ensured` : "no knowledge base: the hybrid search answers"}${base.retired.length ? `; retired knowledge base(s) ${base.retired.map((name) => `"${name}"`).join(", ")} deleted` : ""}`;
	},
	skills: async () => {
		const seeded = await skills.seed();
		return seeded.length
			? `seeded ${seeded.join(", ")}`
			: "nothing to seed: every skill the product ships is stored";
	},
	agent: async () => {
		// The store the operator chose, read afresh: the setting holds per process, and this is a new one.
		const { memory, history, voice: voiceSettings } = await agentSettings();
		const chosen = memoryStoreFor(memory);
		// A stored foundry on a private deployment fails the settings step first; the run-time guard is what answers a step run alone.
		let store =
			chosen === memory.store
				? "the memory store not in use"
				: "the memory store refused on a private deployment, the own store runs";
		if (chosen === "foundry") {
			const { deployments } = await llmSettings();
			const made = await ensureMemoryStore(product, {
				chat: requireDeployment(deployments, "smallChat"),
				embedding: requireDeployment(deployments, "embedding"),
			});
			store = `the memory store ${made === "created" ? "made" : "kept as it is"}`;
		}
		// Said before the versions are made: a speech-to-speech that cannot run is a warning, the cascade is made in its place.
		// The versions are the voice agent's, made whichever runtime is chosen so a switch back needs no deploy: reported as that runtime would run them.
		const { notes } = reportVoiceEngines({
			...voiceSettings,
			runtime: "agent",
		});
		// A refused voice version of an engine that runs throws: the step fails, and the deploy with it.
		const { versions, voice, pruned } = await createFoundryAgentHost(
			product,
		).prime(Object.values(product.surfaces));
		// The live surface is the voice agent's alone: the typed surfaces have prompt versions.
		const typed = Object.values(product.surfaces).filter(
			(s) => s !== product.surfaces.live,
		);
		const threads = historyKeptByService(history)
			? "; new threads on the service's conversations, whose deletes leave the run state's copy until its time to live"
			: "";
		const spoken = Object.entries(voice)
			.map(([engine, version]) => `${version} (${engine})`)
			.join(", ");
		const warnings = notes.map((note) => `; ${note}`).join("");
		return `${store}; version ${versions.join(", ")} for ${typed.join(", ")}; voice ${spoken}; ${pruned} old version(s) pruned${threads}${warnings}`;
	},
	library: async (name) => {
		if (name) return summary(await loadLibrary(name, { onFile: logFile }));
		// With no name the step is the product's own library's, when it ships one.
		if (!product.library) return "the product ships no library";
		return summary(await product.library.load(logFile));
	},
	"remove-library": async (name) => {
		const library = name ?? product.library?.name;
		if (!library) return "the product ships no library";
		const { blobs, chunks } = await removeLibrary(library);
		return `${blobs} blob(s) and ${chunks} chunk(s) deleted`;
	},
	shield: async () => {
		const report = await shieldChunks(null);
		for (const flagged of report.flagged)
			console.warn(
				`[shield] Prompt Shields found an attack in ${flagged.path}: that passage is never served`,
			);
		return `${report.scanned} chunk(s) read, ${report.flagged.length} flagged, ${report.withheld} left unserved for a later scan`;
	},
};

/** The steps that take a library's name. */
const NAMED = new Set(["library", "remove-library"]);

export interface Step {
	label: string;
	name: string;
	argument?: string;
}

/** The arguments as steps, every one checked before any runs. */
export function parseSteps(args: readonly string[]): Step[] {
	if (args.length === 0)
		throw new Error(`name a step: ${Object.keys(STEPS).join(", ")}`);
	return args.map((label) => {
		const [name = "", argument] = label.split(/:(.*)/s, 2);
		if (!Object.hasOwn(STEPS, name)) throw new Error(`unknown step "${label}"`);
		if (
			argument !== undefined &&
			(!NAMED.has(name) || !LIBRARY_NAME.test(argument))
		)
			throw new Error(`"${label}" takes no such argument`);
		return { label, name, argument };
	});
}

/** Run the steps in order; false after the first that failed, which stops the rest. */
export async function runSteps(
	steps: readonly Step[],
	runners: Record<string, StepRunner> = STEPS,
): Promise<boolean> {
	for (const step of steps) {
		try {
			const runner = Object.hasOwn(runners, step.name)
				? runners[step.name]
				: undefined;
			if (!runner) throw new Error(`no runner for the step "${step.name}"`);
			console.log(`[${step.label}] ${await runner(step.argument)}`);
		} catch (err) {
			console.error(`[${step.label}] failed:`, err);
			return false;
		}
	}
	return true;
}

if (import.meta.main) {
	assertDeploymentSafe(cosmosDeploymentRules);
	try {
		if (!(await runSteps(parseSteps(process.argv.slice(2)))))
			process.exitCode = 1;
	} finally {
		await closeRedis();
		closeCosmos();
	}
}
