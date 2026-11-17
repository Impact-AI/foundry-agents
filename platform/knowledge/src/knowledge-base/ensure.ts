import { settledAccessSettings } from "../config/access";
import { knowledgeSettings } from "../config/knowledge";
import { searchIndexClient, searchRestWriter } from "../index/client";
import { applied } from "../pipeline/ensure";
import {
	knowledgeBaseDefinition,
	knowledgeBasePlanner,
	knowledgeBaseUrl,
	knowledgeSourceDefinition,
	retiredKnowledgeBaseNames,
} from "./definition";
import { retrievalEngine } from "./engine";

/**
 * The job's `index` step, continued: the source and then the base that
 * names it, made or brought up to date, when the engine is the knowledge
 * base — carrying the planning model whenever the deployment has one, so
 * every effort is a call away; nothing when it is not, so a deployment on
 * the hybrid search holds no knowledge base at all. A base already made is
 * updated in place: a change of index name is a new base, and the old one
 * stays until deleted. Either way, the bases an earlier shape of the
 * engine made beside it, one per effort, are deleted where they are left
 * (`retiredKnowledgeBaseNames`); a name that is not there is already
 * done. The source goes through the SDK; the base is PUT by REST on the
 * preview version, the only one that takes its model and effort
 * (`KNOWLEDGE_BASE_PREVIEW_API_VERSION`).
 *
 * Whether the base answers depends on the `access` document too, and a
 * search that cannot read it falls to the hybrid query, which refuses. This
 * step must not read that fallback as the operator's choice: with the
 * engine set to the knowledge base, a store that does not answer fails the
 * step, since a base left unmade is one every replica that later reads the
 * document would call and not find.
 */
export async function ensureKnowledgeBase(): Promise<{
	made: string | null;
	retired: string[];
}> {
	const retired = await retireKnowledgeBases();
	if ((await knowledgeSettings()).retrieval.engine === "knowledgeBase")
		await settledAccessSettings();
	if ((await retrievalEngine()) !== "knowledgeBase")
		return { made: null, retired };
	const indexes = searchIndexClient();
	await applied(
		indexes.createOrUpdateKnowledgeSource(knowledgeSourceDefinition()),
	);
	const base = knowledgeBaseDefinition(knowledgeBasePlanner());
	await applied(searchRestWriter().put(knowledgeBaseUrl(), base));
	return { made: base.name, retired };
}

/**
 * The retired bases this run deleted. The SDK's delete answers a base the
 * service does not hold as done, so each is read first: a 404 there is one
 * already gone, and not reported as deleted.
 */
async function retireKnowledgeBases(): Promise<string[]> {
	const deleted: string[] = [];
	for (const name of retiredKnowledgeBaseNames()) {
		try {
			await searchIndexClient().getKnowledgeBase(name);
		} catch (err) {
			if ((err as { statusCode?: number }).statusCode === 404) continue;
			throw err;
		}
		await searchIndexClient().deleteKnowledgeBase(name);
		deleted.push(name);
	}
	return deleted;
}
