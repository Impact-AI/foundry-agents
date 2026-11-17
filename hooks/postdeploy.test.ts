/**
 * postdeploy with `az` stood in for on PATH, each twin in turn, recording every call: the
 * job is pointed at the image azd built and the deploy's steps by `job
 * update` (which keeps the job's environment), then started once and waited
 * for; the last step loads the sample library, or removes it when the
 * parameter says not, and a failed execution fails the deploy with its log.
 * A status that cannot be read is asked again, and five in a row end the wait.
 * Every call names the environment's subscription, never az's default.
 * Before the job, an app azd deployed that holds no health probes is given
 * the template's, from the environment the provision wrote, as one merge
 * patch of its container; an app that holds them is left alone.
 */
import { expect } from "bun:test";
import { join } from "node:path";
import { standInAz } from "./stand-in-az";
import { eachTwin, runTwin, type Shell } from "./twins";

const HOOK = join(import.meta.dir, "postdeploy");

function deploy(
	shell: Shell,
	env: Record<string, string>,
	status = "Succeeded",
	failing: { failing?: string; failingTimes?: number; heldProbe?: string } = {},
) {
	// `sleep` stood in for, so a poll that is asked again costs no time.
	const az = standInAz(status, { ...failing, bin: { sleep: "exit 0" } });
	const result = runTwin(
		shell,
		HOOK,
		[],
		{
			...az.env,
			SERVICE_BACKEND_IMAGE_NAME: "registry/backend:7",
			AZURE_SUBSCRIPTION_ID: "sub",
			AZURE_RESOURCE_GROUP: "rg",
			MIGRATE_JOB_NAME: "job",
			...env,
		},
		// As azd starts a posix hook.
		"sh",
	);
	return { ...result, ...az.read() };
}

eachTwin(
	"one execution: the image azd built, the settings, the index, the skills, the agent and the sample library",
	(shell) => {
		const run = deploy(shell, {});
		expect(run.exitCode).toBe(0);
		expect(run.job).toEqual([
			"update --image registry/backend:7 --args src/job.ts settings index skills agent library",
			"start",
		]);
		expect(run.said).toMatch(
			/deploy \(settings index skills agent library\): started exec-\d+\n/,
		);
		expect(run.said).toMatch(
			/deploy \(settings index skills agent library\): exec-\d+ succeeded/,
		);
		expect(run.subscribed).toBe(true);
	},
);

eachTwin(
	"an environment naming no subscription fails before any call, rather than asking az's default",
	(shell) => {
		const run = deploy(shell, { AZURE_SUBSCRIPTION_ID: "" });
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain(
			"postdeploy: AZURE_SUBSCRIPTION_ID is not in the azd environment; run azd up first",
		);
		expect(run.all).toEqual([]);
	},
);

eachTwin(
	"a deploy azd gave no image stops before any call, saying which variable",
	(shell) => {
		const run = deploy(shell, { SERVICE_BACKEND_IMAGE_NAME: "" });
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain(
			"azd sets SERVICE_BACKEND_IMAGE_NAME after deploying the backend",
		);
		expect(run.all).toEqual([]);
	},
);

for (const value of ["false", "False"])
	eachTwin(
		`SEED_SAMPLE_LIBRARY=${value} removes the sample library`,
		(shell) => {
			const run = deploy(shell, { SEED_SAMPLE_LIBRARY: value });
			expect(run.exitCode).toBe(0);
			expect(run.job).toEqual([
				"update --image registry/backend:7 --args src/job.ts settings index skills agent remove-library",
				"start",
			]);
		},
	);

eachTwin(
	"a failed execution fails the deploy and prints the job's log, its last 200 lines",
	(shell) => {
		const run = deploy(shell, {}, "Failed");
		expect(run.exitCode).toBe(1);
		expect(run.said).toMatch(/exec-\d+ ended Failed/);
		expect(run.calls).toMatch(
			/job logs show .* --container migrate --tail 200$/m,
		);
		expect(run.subscribed).toBe(true);
	},
);

eachTwin(
	"a job that cannot be pointed at the image, or does not start, fails the deploy before it waits",
	(shell) => {
		const unpointed = deploy(shell, {}, "Succeeded", { failing: "job update" });
		expect(unpointed.exitCode).toBe(1);
		expect(unpointed.job).toHaveLength(1);
		const unstarted = deploy(shell, {}, "Succeeded", { failing: "job start" });
		expect(unstarted.exitCode).toBe(1);
		expect(unstarted.calls).not.toContain("execution show");
	},
);

eachTwin(
	"a status that cannot be read is asked again, and the execution's end is still what decides",
	(shell) => {
		const run = deploy(shell, {}, "Succeeded", {
			failing: "execution show",
			failingTimes: 4,
		});
		expect(run.exitCode).toBe(0);
		expect(run.all.filter((l) => l.includes("execution show"))).toHaveLength(5);
		expect(run.said).toMatch(/exec-\d+ succeeded/);
	},
);

eachTwin(
	"five unread statuses in a row end the wait, naming the execution that may still be running",
	(shell) => {
		const run = deploy(shell, {}, "Succeeded", { failing: "execution show" });
		expect(run.exitCode).toBe(1);
		expect(run.all.filter((l) => l.includes("execution show"))).toHaveLength(5);
		expect(run.said).toMatch(
			/the status of exec-\d+ could not be read five times in a row; it may still be running/,
		);
	},
);

const PROBES = JSON.stringify([
	{
		type: "Readiness",
		httpGet: { path: "/ready", port: 4111, scheme: "HTTP" },
		periodSeconds: 10,
	},
	{
		type: "Liveness",
		httpGet: { path: "/health", port: 4111, scheme: "HTTP" },
		periodSeconds: 30,
	},
]);
const PROBED = {
	BACKEND_APP_NAME: "ca-backend",
	BACKEND_PROBES: PROBES,
	FRONTEND_APP_NAME: "ca-frontend",
	FRONTEND_PROBES: PROBES,
};

eachTwin(
	"an app azd deployed with no probes is given the template's, its container otherwise kept, before the job runs",
	(shell) => {
		const run = deploy(shell, PROBED);
		expect(run.exitCode).toBe(0);
		const patches = run.all.filter((l) => l.includes("--method patch"));
		expect(patches).toHaveLength(2);
		for (const [i, app] of ["ca-backend", "ca-frontend"].entries())
			expect(patches[i]).toBe(
				`rest --subscription sub --method patch --url /subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/containerApps/${app} --url-parameters api-version=2026-01-01 --body ${patches[i]?.split("--body ")[1]?.split(" ")[0]} -o none`,
			);
		for (const body of run.bodies)
			expect(body).toEqual({
				properties: {
					template: {
						revisionSuffix: null,
						containers: [
							{
								name: "app",
								image: "registry/app:1",
								env: [{ name: "PORT", value: "1" }],
								probes: JSON.parse(PROBES),
							},
						],
					},
				},
			});
		expect(run.said).toContain(
			"postdeploy: ca-backend given its health probes",
		);
		expect(run.said).toContain(
			"postdeploy: ca-frontend given its health probes",
		);
		// The probes first, so a failed job leaves the apps watched.
		expect(run.all.findIndex((l) => l.includes("--method patch"))).toBeLessThan(
			run.all.findIndex((l) => l.includes("job update")),
		);
		expect(run.subscribed).toBe(true);
	},
);

eachTwin("an app that holds its probes is left as it is", (shell) => {
	const run = deploy(shell, PROBED, "Succeeded", { heldProbe: "Readiness" });
	expect(run.exitCode).toBe(0);
	expect(run.all.filter((l) => l.startsWith("rest "))).toEqual([]);
	expect(run.all.filter((l) => l.includes("containerapp show"))).toHaveLength(
		2,
	);
});

eachTwin(
	"an environment provisioned before the probes were outputs says so and deploys",
	(shell) => {
		const run = deploy(shell, {});
		expect(run.exitCode).toBe(0);
		expect(run.said).toContain(
			"postdeploy: the azd environment names no app or no probes to give it; azd provision gives the probes",
		);
		expect(run.all.filter((l) => l.includes("containerapp show"))).toEqual([]);
	},
);

eachTwin(
	"a patch that fails fails the deploy before the job, naming the app",
	(shell) => {
		const run = deploy(shell, PROBED, "Succeeded", {
			failing: "--method patch",
		});
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain(
			"postdeploy: could not give the app ca-backend its health probes",
		);
		expect(run.job).toEqual([]);
	},
);
