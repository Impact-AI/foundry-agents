/**
 * Who may do what with the library, as the compiled template grants it:
 * the migrate job's identity makes AI Search's index, data source, skillset
 * and indexer, writes each file's description into its blob, deletes a
 * removed file's chunks and writes what Prompt Shields said (the account's
 * whole data plane: Cognitive Services User); the backend only reads the
 * index and the library's blobs; AI Search's own identity reads the library
 * and reaches the account for its OCR and embeddings. The job holds all of
 * it whether or not the sample is loaded, because the ingest script loads
 * people's own documents through it. `seedSampleLibrary` — SEED_SAMPLE_LIBRARY
 * in azd — decides only whether the deploy's steps end by loading the sample
 * library or by removing it.
 */
import { expect, test } from "bun:test";
import {
	compiledMain,
	type Deployment,
	moduleCalls,
	parameterFile,
	sampleDeployment,
} from "./arm";

const it = test.skipIf(compiledMain() === null);

type Assignment = { principalId: unknown; roleDefinitionIdOrName: string };

/** Each identity's roles on the resource one module creates, by who holds them. */
function rolesOn(d: Deployment, mainType: string) {
	const call = moduleCalls(d).find((m) => m.mainType === mainType);
	if (!call) throw new Error(`no ${mainType}`);
	const roles = call.parameters.roleAssignments as Assignment[];
	const of = (who: string) =>
		roles
			.filter((r) => JSON.stringify(r.principalId).includes(who))
			.map((r) => r.roleDefinitionIdOrName)
			.sort();
	return {
		migrate: of("outputs.migrate."),
		backend: of("outputs.backend."),
		search: of("reference(search)"),
	};
}

/** The migrate job's container: what it runs and rests on. */
function jobContainer(d: Deployment) {
	const job = moduleCalls(d).find((m) => m.mainType === "Microsoft.App/jobs");
	if (!job) throw new Error("no migrate job");
	const [container] = job.parameters.containers as {
		command: string[];
		args: string[];
		env: { name: string; value?: unknown }[];
	}[];
	return container;
}

const SEARCH = "Microsoft.Search/searchServices";
const STORAGE = "Microsoft.Storage/storageAccounts";
const MODELS = "Microsoft.CognitiveServices/accounts";
const SETTINGS = "Microsoft.AppConfiguration/configurationStores";

it("the migrate job's identity may make the pipeline and write the index; the backend's only reads it", () => {
	for (const seedSampleLibrary of [true, false]) {
		const search = rolesOn(
			sampleDeployment({ seedSampleLibrary }) as Deployment,
			SEARCH,
		);
		expect(search.migrate).toEqual([
			"Search Index Data Contributor",
			"Search Service Contributor",
		]);
		expect(search.backend).toEqual(["Search Index Data Reader"]);
	}
});

it("the job writes the library's blobs and reaches Prompt Shields; the backend only reads the library; AI Search's own identity reads it and calls the account", () => {
	for (const seedSampleLibrary of [true, false]) {
		const d = sampleDeployment({ seedSampleLibrary }) as Deployment;
		expect(rolesOn(d, STORAGE).migrate).toEqual([
			"Storage Blob Data Contributor",
		]);
		expect(rolesOn(d, STORAGE).backend).toEqual(["Storage Blob Data Reader"]);
		expect(rolesOn(d, STORAGE).search).toEqual(["Storage Blob Data Reader"]);
		expect(rolesOn(d, MODELS).migrate).toEqual([
			"Cognitive Services OpenAI User",
			"Cognitive Services User",
		]);
		expect(rolesOn(d, MODELS).search).toEqual(["Cognitive Services User"]);
	}
});

it("the job writes the settings documents, and the backend only reads them", () => {
	const settings = rolesOn(sampleDeployment() as Deployment, SETTINGS);
	expect(settings.migrate).toEqual(["App Configuration Data Owner"]);
	expect(settings.backend).toEqual(["App Configuration Data Reader"]);
});

it("the parameter is on unless the azd environment says otherwise, and reaches the hooks as an output", () => {
	expect(parameterFile({}).seedSampleLibrary).toBe("true");
	expect(
		parameterFile({ SEED_SAMPLE_LIBRARY: "false" }).seedSampleLibrary,
	).toBe("false");
	const outputs = (compiledMain()?.outputs ?? {}) as Record<
		string,
		{ type: string; value: unknown }
	>;
	expect(outputs.SEED_SAMPLE_LIBRARY).toEqual({
		type: "bool",
		value: "[parameters('seedSampleLibrary')]",
	});
});

it("the job rests on the deploy's steps, which make the pipeline and end by loading the sample library, or by removing it when it is off", () => {
	const on = jobContainer(sampleDeployment() as Deployment);
	expect(on?.command).toEqual(["bun", "--use-system-ca", "run"]);
	expect(on?.args).toEqual([
		"src/job.ts",
		"settings",
		"index",
		"skills",
		"agent",
		"library",
	]);
	const off = jobContainer(
		sampleDeployment({ seedSampleLibrary: false }) as Deployment,
	);
	expect(off?.args).toEqual([
		"src/job.ts",
		"settings",
		"index",
		"skills",
		"agent",
		"remove-library",
	]);
});

it("the job names the storage account by its resource id, which the indexer's data source connects with, and the embedding model beside its deployment", () => {
	const env = Object.fromEntries(
		(jobContainer(sampleDeployment() as Deployment)?.env ?? []).map((e) => [
			e.name,
			JSON.stringify(e.value),
		]),
	);
	expect(env.AZURE_STORAGE_RESOURCE_ID).toContain(
		"reference(storage).outputs.resourceId",
	);
	expect(env.AZURE_STORAGE_CONTAINER).toContain(
		"reference(storage).outputs.libraryContainer",
	);
	expect(env.AZURE_STORAGE_APPEARANCE_CONTAINER).toContain(
		"reference(storage).outputs.appearanceContainer",
	);
	expect(env.AZURE_OPENAI_EMBEDDING_MODEL).toBe('"text-embedding-3-large"');
});

// Deletion detection in AI Search's indexer finds a deleted file through
// blob soft delete, so the library's account keeps deleted blobs a week. The
// logo has a container of its own, so the indexer never reads it.
it("the library's account keeps deleted blobs for seven days, and holds the library container and the appearance one", () => {
	const storage = moduleCalls(sampleDeployment() as Deployment).find(
		(m) => m.mainType === STORAGE,
	)?.parameters as { blobServices: Record<string, unknown> };
	expect(storage.blobServices).toMatchObject({
		deleteRetentionPolicyEnabled: true,
		deleteRetentionPolicyDays: 7,
		containers: [
			{ name: "library", publicAccess: "None" },
			{ name: "appearance", publicAccess: "None" },
		],
	});
});
