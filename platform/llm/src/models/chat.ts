import { azureOpenAI } from "../azure-auth";
import { llmSettings } from "../config";
import { MODEL_ROLES, requireDeployment } from "../deployment";
import {
	type BoundLanguageModel,
	boundLanguageModel,
	roleLimiter,
} from "./bound";
import { reasoningModel } from "./reasoning";

/**
 * The model for work the full model is a waste on — a conversation's title,
 * a search's plan — on the Responses API, with its bounds. Resolved per call
 * so a retuned deployment is picked up at the memo's pace. Its own slot, not
 * a cheaper alias: unconfigured means unconfigured, never "use the chat model
 * instead". The chat model itself is the agent's, behind Foundry Agent
 * Service, and is never called from here.
 */
export async function smallChatModel(): Promise<BoundLanguageModel> {
	const settings = await llmSettings();
	return boundLanguageModel(
		azureOpenAI().responses(
			requireDeployment(settings.deployments, "smallChat"),
		),
		{ limiter: roleLimiter("smallChat"), retry: settings.retry },
		MODEL_ROLES.specs.smallChat.reasoning ? [reasoningModel] : [],
	);
}
