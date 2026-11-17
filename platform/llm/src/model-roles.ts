/**
 * A table of model roles, and the rule that none of them has a compiled-in
 * name.
 *
 * A deployment name is a fact about one environment's Azure OpenAI account. A
 * literal in code names a deployment that exists on whichever account its
 * author was looking at, and on every other account it is a 404 from inside
 * the SDK's retry loop, several layers away from the setting that is actually
 * missing. So an unnamed role is {@link ModelNotConfiguredError} at the point a
 * model is asked for — never a guess, and never another role's deployment.
 *
 * The table is the one way a package names its roles: an environment variable
 * per role, read once when the package's settings are first built, and the
 * typed refusal naming it. The environment is the only source: a name has no
 * default to compile in and nothing else may answer for it. This package's
 * own roles are one call; a sibling package with roles of its own makes
 * another.
 */
import { envString } from "@platform/config";

export interface ModelRoleSpec {
	/** The thing that is missing, for the error message. */
	what: string;
	/** The environment variable that names the deployment. */
	envVar: string;
	/**
	 * The role is served by a reasoning model. The provider guesses that from
	 * the deployment's name, and a deployment named for its role reads as none.
	 */
	reasoning?: true;
}

/** The variable that names the Azure OpenAI account every deployment is on. */
export const RESOURCE_NAME_VAR = "AZURE_OPENAI_RESOURCE_NAME";

/**
 * Something was asked of a model this environment does not name. Not an
 * outage, not a refusal, not a fault: this environment does not have the
 * thing, and a caller that can degrade should. `"account"` is the resource
 * itself; any other `role` carries the spec that says which variable names it.
 */
export class ModelNotConfiguredError extends Error {
	constructor(role: "account");
	constructor(role: string, spec: ModelRoleSpec);
	constructor(
		readonly role: string,
		spec?: ModelRoleSpec,
	) {
		super(
			spec
				? `${spec.what} is not configured in this environment: set ${spec.envVar} to a deployment that exists on this account.`
				: `The Azure OpenAI account is not configured: ${RESOURCE_NAME_VAR} is unset.`,
		);
		this.name = "ModelNotConfiguredError";
	}
}

/**
 * A deployment name out of a setting, or nothing. Blank is absent: an unset
 * template parameter renders as "", and a deployment named "" is one nobody
 * named.
 */
export function deploymentName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface ModelRoles<R extends string> {
	readonly specs: Readonly<Record<R, ModelRoleSpec>>;
	readonly names: readonly R[];
	/** The deployments the environment names; a blank variable names none. */
	fromEnvironment(): Partial<Record<R, string>>;
	/** The deployment for `role`, or the typed refusal before any bytes leave. */
	require(deployments: Partial<Record<R, string>>, role: R): string;
	readonly NotConfiguredError: new (role: R) => ModelNotConfiguredError;
}

export function defineModelRoles<R extends string>(
	specs: Record<R, ModelRoleSpec>,
): ModelRoles<R> {
	const names = Object.keys(specs) as R[];

	class NotConfiguredError extends ModelNotConfiguredError {
		constructor(role: R) {
			super(role, specs[role]);
		}
	}

	return {
		specs,
		names,
		fromEnvironment() {
			const deployments: Partial<Record<R, string>> = {};
			for (const role of names) {
				const name = deploymentName(envString(specs[role].envVar));
				if (name) deployments[role] = name;
			}
			return deployments;
		},
		require(deployments, role) {
			const name = deploymentName(deployments[role]);
			if (!name) throw new NotConfiguredError(role);
			return name;
		},
		NotConfiguredError,
	};
}
