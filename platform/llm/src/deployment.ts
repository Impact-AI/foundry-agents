/** Which model does what: this package's three roles, as one table. */
import { defineModelRoles } from "./model-roles";

export type ModelRole = "chat" | "smallChat" | "embedding";

export const MODEL_ROLES = defineModelRoles<ModelRole>({
	chat: {
		what: "The chat model",
		envVar: "AZURE_OPENAI_CHAT_DEPLOYMENT",
		reasoning: true,
	},
	smallChat: {
		what: "The small chat model",
		envVar: "AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT",
		reasoning: true,
	},
	embedding: {
		what: "The embedding model",
		envVar: "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
	},
});

export type Deployments = Partial<Record<ModelRole, string>>;

/** The deployment for `role`, or the typed refusal before any bytes leave. */
export function requireDeployment(
	deployments: Deployments,
	role: ModelRole,
): string {
	return MODEL_ROLES.require(deployments, role);
}
