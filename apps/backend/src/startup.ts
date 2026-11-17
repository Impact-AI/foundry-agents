import { type CosmosAccess, checkCosmos } from "@platform/cosmos";
import { cosmosContainers } from "./containers";

export interface Startup {
	/** Whether the host has started: what the readiness route answers. */
	ready(): boolean;
	/** Wait for the services to admit this identity, then start the host. Rejects as a failed start always has. */
	run(): Promise<void>;
}

export interface StartupOptions {
	check?: () => Promise<CosmosAccess>;
	retryMs?: number;
	/** How long a refusal is waited out before it is a failed start. */
	waitMs?: number;
}

/** Another look every few seconds. */
const RETRY_MS = 10_000;

/**
 * Past the minutes a role assignment takes to apply. A refusal that outlasts
 * it is not lag — the wrong identity, a missing assignment, a firewall — and
 * a start that fails says so where a wait would hide it: the revision fails
 * and the platform keeps traffic on the one before.
 */
const ADMISSION_WAIT_MS = 15 * 60_000;

/**
 * What a data plane says in refusing an identity whose role is not there:
 * the code it answers with, or the same code, or its one sentence, in the
 * message. Nothing wider: a token for the wrong audience or tenant is
 * "not authorized" too, and no wait mends that.
 */
const NO_PERMISSION_CODE = /^PermissionDenied$/i;
const NO_PERMISSION_SAID =
	/\bPermissionDenied\b|does not have access to API\/Operation/i;

/**
 * A service refusing this identity: on the error itself, or on what it was
 * raised from. A 403 is one whatever it says. So is a 401 that names a
 * missing permission (`PermissionDenied`): that an identity whose role
 * assignment has not applied yet is answered 401 by some data planes — the
 * agent service's and the models' among them — where others answer 403 is
 * known only from the services' behaviour. Any other 401 is not one: a
 * token nobody accepts, or one for another audience or tenant, is a
 * misconfiguration no wait mends, and waiting on it would hide it for as
 * long as the wait lasts.
 */
function isRefusal(err: unknown): boolean {
	for (let at = err, depth = 0; at && depth < 5; depth++) {
		if (typeof at !== "object") return false;
		const { status, statusCode, code, error, message, cause } = at as {
			status?: unknown;
			statusCode?: unknown;
			code?: unknown;
			error?: { code?: unknown; message?: unknown } | null;
			message?: unknown;
			cause?: unknown;
		};
		const answered = status ?? statusCode;
		if (answered === 403) return true;
		if (
			answered === 401 &&
			([code, error?.code].some(
				(named) => typeof named === "string" && NO_PERMISSION_CODE.test(named),
			) ||
				[message, error?.message].some(
					(said) => typeof said === "string" && NO_PERMISSION_SAID.test(said),
				))
		)
			return true;
		at = cause;
	}
	return false;
}

/**
 * The host's start, held until the services it reads admit this replica's
 * own identity. On a first deploy the replica starts while the template's
 * role assignments are still applying — Cosmos DB's to every container the
 * stores declare, then whatever `start` itself asks of, the search index
 * and the agent service among them — so a refusal is waited out: one
 * warning for each service, the readiness route answering 503, another look
 * every few seconds, instead of a crash loop. Any other failure is a failed
 * start, and so is a refusal still standing after `waitMs`. `start` is
 * called again after a refusal, so everything it does before its last
 * check is safe to repeat.
 */
export function startWhenAdmitted(
	start: () => Promise<void>,
	options: StartupOptions = {},
): Startup {
	const check = options.check ?? (() => checkCosmos(cosmosContainers));
	const retryMs = options.retryMs ?? RETRY_MS;
	const waitMs = options.waitMs ?? ADMISSION_WAIT_MS;
	let started = false;

	/** Ask until `admitted` answers true, or the wait is spent. */
	async function waitFor(
		service: string,
		admitted: () => Promise<boolean>,
		deadline: number,
	): Promise<void> {
		let waited = false;
		while (!(await admitted())) {
			if (Date.now() >= deadline)
				throw new Error(
					`${service} still refuses this identity after ${Math.round(waitMs / 60_000)} minutes: check its role assignment`,
				);
			if (!waited)
				console.warn(
					`[backend] ${service} does not admit this identity yet: a role assignment can take minutes to apply. Not ready until it does.`,
				);
			waited = true;
			await Bun.sleep(retryMs);
		}
		if (waited) console.log(`[backend] ${service} admits this identity now`);
	}

	return {
		ready: () => started,
		async run() {
			const deadline = Date.now() + waitMs;
			await waitFor(
				"Cosmos DB",
				async () => (await check()) !== "awaiting-roles",
				deadline,
			);
			await waitFor(
				"a service the host reads at its start",
				async () => {
					try {
						await start();
						return true;
					} catch (err) {
						if (!isRefusal(err)) throw err;
						return false;
					}
				},
				deadline,
			);
			started = true;
		},
	};
}
