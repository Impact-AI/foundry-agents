/**
 * Refuse to start a deployed replica whose environment is unsafe.
 *
 * A development substitute that is correct on a laptop is an incident in a
 * deployment, and the failure is quiet either way: nothing crashes, so nothing
 * pages. So the entry module of every deployable app calls
 * {@link assertDeploymentSafe} with the rules its packages export, and a
 * misconfigured revision crash-loops instead of serving — the platform then
 * keeps traffic on the previous revision.
 *
 * Dependency-free, like `./env` it reads a toggle through, so an edge runtime
 * can load it.
 */
import { isOn } from "./env";

/** A rule answers with the problem it found, or `null`. */
export interface DeploymentRule {
	check(env: Readonly<Record<string, string | undefined>>): string | null;
}

/** Azure Container Apps sets this on every replica; nothing sets it on a laptop. */
export function isDeployedEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return Boolean(env.CONTAINER_APP_NAME?.trim());
}

/**
 * Whether this process serves people: a Container Apps replica, or the
 * production image wherever else it runs — App Service, Kubernetes, a bare
 * `docker run` — which sets `NODE_ENV=production` and nothing Azure-specific.
 * Keying on the platform alone would let the same image serve open there.
 */
export function isProductionRuntime(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return isDeployedEnvironment(env) || env.NODE_ENV?.trim() === "production";
}

/**
 * Azure Container Apps sets this on every execution of a job, and not
 * `CONTAINER_APP_NAME`: a job is the deployment acting on itself, never a
 * replica serving requests, so it answers neither question for the other.
 */
export function isDeployedJob(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return Boolean(env.CONTAINER_APP_JOB_NAME?.trim());
}

/**
 * A toggle that must be off. What it holds is never printed: anything but the
 * off words reads as on, so the value may be something pasted into the wrong
 * variable, and the problem is written to the container's log on every restart.
 */
export function forbidWhenActive(name: string, effect: string): DeploymentRule {
	return {
		check: (env) => (isOn(env[name]) ? `${name} is on — ${effect}.` : null),
	};
}

/**
 * A variable that names a thing rather than toggling one: any value is
 * refused. The value is never printed: what is refused here may be a key, and
 * the problem is written to the container's log on every restart.
 */
export function forbidWhenSet(name: string, effect: string): DeploymentRule {
	return {
		check: (env) => (env[name]?.trim() ? `${name} is set — ${effect}.` : null),
	};
}

/** A control whose absence fails open. */
export function requireNonEmpty(name: string, effect: string): DeploymentRule {
	return {
		check: (env) =>
			env[name]?.trim() ? null : `${name} is missing or empty — ${effect}.`,
	};
}

/** One specific value that must never be set. The value printed is the rule's own, never what the environment holds. */
export function refuseValue(
	name: string,
	value: string,
	effect: string,
): DeploymentRule {
	return {
		check: (env) =>
			env[name]?.trim() === value ? `${name}="${value}" — ${effect}.` : null,
	};
}

/**
 * Throw, naming every offending variable at once, when this process serves
 * people ({@link isProductionRuntime}) and any rule finds a problem. A no-op
 * on a laptop.
 */
export function assertDeploymentSafe(
	rules: readonly DeploymentRule[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): void {
	if (!isProductionRuntime(env)) return;
	const problems = rules
		.map((rule) => rule.check(env))
		.filter((p): p is string => p !== null);
	if (problems.length === 0) return;
	const why = isDeployedEnvironment(env)
		? `CONTAINER_APP_NAME="${env.CONTAINER_APP_NAME}"`
		: `NODE_ENV="${env.NODE_ENV}"`;
	throw new Error(
		`Refusing to start: this is a production process (${why}) ` +
			"and its configuration is not safe to serve users with.\n\n" +
			problems.map((p) => `  * ${p}`).join("\n\n") +
			"\n\nFix the environment variables and redeploy; this process will keep failing to start until you do.",
	);
}
