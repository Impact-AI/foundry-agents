/**
 * predown with `az` stood in for on PATH, each twin in turn. Before `azd down` deletes the
 * group, the hook lifts the locks and takes the Agent Service's capability
 * hosts down in the one order the service accepts: every project's, then the
 * account's. An account that is already gone is nothing to do; any other
 * refusal stops the hook rather than leave a subnet held. An environment
 * whose provision never completed holds none of the template's outputs: the
 * group is found by the template's own name for it and the account by asking
 * the group, and a group that does not exist is nothing to do.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eachTwin, runTwin, type Shell } from "./twins";

const HOOK = join(import.meta.dir, "predown");
const accountIn = (group: string) =>
	`/subscriptions/sub/resourceGroups/${group}/providers/Microsoft.CognitiveServices/accounts/oai-x`;
const ACCOUNT = accountIn("rg");

function run(
	shell: Shell,
	env: Record<string, string>,
	options: {
		account?: "exists" | "missing" | "refused";
		/** The group az knows, and whether it exists; the accounts it lists. */
		group?: string;
		groupExists?: boolean;
		listed?: string;
		/** A call az refuses. */
		refuse?: string;
	} = {},
) {
	const ACCOUNT = accountIn(options.group ?? "rg");
	const bin = mkdtempSync(join(tmpdir(), "predown-"));
	const calls = join(bin, "calls");
	writeFileSync(calls, "");
	const show =
		options.account === "missing"
			? "echo '(ResourceNotFound) The Resource was not found.' >&2; exit 3"
			: options.account === "refused"
				? "echo '(AuthorizationFailed) The client may not read it.' >&2; exit 1"
				: "";
	writeFileSync(
		join(bin, "az"),
		`#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
${options.refuse ? `"${options.refuse}"*) exit 1 ;;` : ""}
"group exists"*) echo ${options.groupExists === false ? "false" : "true"} ;;
"cognitiveservices account list"*) ${options.listed ? `echo ${options.listed}` : ":"} ;;
"lock list"*) echo lock-1 ;;
"resource show"*) ${show} ;;
*"${ACCOUNT}/projects?"*) echo "${ACCOUNT}/projects/agent" ;;
*"${ACCOUNT}/projects/agent/capabilityHosts?"*) echo "${ACCOUNT}/projects/agent/capabilityHosts/agents" ;;
*"${ACCOUNT}/capabilityHosts?"*) echo "${ACCOUNT}/capabilityHosts/oai-x@aml_aiagentservice" ;;
esac
`,
	);
	chmodSync(join(bin, "az"), 0o755);
	const result = runTwin(shell, HOOK, [], {
		PATH: `${bin}:${process.env.PATH}`,
		...(options.group ? {} : { AZURE_RESOURCE_GROUP: "rg" }),
		AZURE_SUBSCRIPTION_ID: "sub",
		...env,
	});
	return {
		...result,
		calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
	};
}

const deletes = (calls: string[]) =>
	calls
		.filter((c) => /^(lock|resource) delete/.test(c))
		.map((c) =>
			c.replace(/ --api-version \S+| -o none| --subscription sub/g, ""),
		);

eachTwin(
	"lifts the locks, then deletes the project's capability host before the account's",
	(shell) => {
		const { exitCode, calls } = run(shell, {
			AZURE_OPENAI_RESOURCE_NAME: "oai-x",
		});
		expect(exitCode).toBe(0);
		// Every call names the environment's subscription, never az's default.
		for (const call of calls) expect(call).toContain("--subscription sub ");
		expect(deletes(calls)).toEqual([
			"lock delete --ids lock-1",
			`resource delete --ids ${ACCOUNT}/projects/agent/capabilityHosts/agents`,
			`resource delete --ids ${ACCOUNT}/capabilityHosts/oai-x@aml_aiagentservice`,
		]);
	},
);

eachTwin(
	"an environment that was never provisioned, or whose account is gone, only loses its locks",
	(shell) => {
		for (const [env, account] of [
			[{}, "exists"],
			[{ AZURE_OPENAI_RESOURCE_NAME: "oai-x" }, "missing"],
		] as const) {
			const { exitCode, calls } = run(shell, env, { account });
			expect(exitCode).toBe(0);
			expect(deletes(calls)).toEqual(["lock delete --ids lock-1"]);
		}
	},
);

eachTwin(
	"an environment whose provision never completed names no group: one that was never made is nothing to do, and nothing is deleted",
	(shell) => {
		const { exitCode, said, calls } = run(
			shell,
			{ AZURE_ENV_NAME: "env-1" },
			{ group: "rg-env-1", groupExists: false },
		);
		expect(exitCode).toBe(0);
		expect(said).toBe("");
		expect(calls).toEqual(["group exists --subscription sub -n rg-env-1"]);
	},
);

eachTwin(
	"a provision that failed after making the group and the account: the locks come off the group the template names, and the hosts of the account the group holds",
	(shell) => {
		const { exitCode, calls } = run(
			shell,
			{ AZURE_ENV_NAME: "env-1" },
			{ group: "rg-env-1", listed: "oai-x" },
		);
		expect(exitCode).toBe(0);
		expect(calls).toContain(
			"lock list --subscription sub -g rg-env-1 --query [].id -o tsv",
		);
		expect(calls).toContain(
			"cognitiveservices account list --subscription sub -g rg-env-1 --query [?kind=='AIServices'].name -o tsv",
		);
		const account = accountIn("rg-env-1");
		expect(deletes(calls)).toEqual([
			"lock delete --ids lock-1",
			`resource delete --ids ${account}/projects/agent/capabilityHosts/agents`,
			`resource delete --ids ${account}/capabilityHosts/oai-x@aml_aiagentservice`,
		]);
		for (const call of calls) expect(call).toContain("--subscription sub ");
	},
);

eachTwin(
	"an environment that names neither its group nor itself stops, saying so",
	(shell) => {
		const { exitCode, said, calls } = run(shell, {}, { group: "none" });
		expect(exitCode).toBe(1);
		expect(said).toContain(
			"neither AZURE_RESOURCE_GROUP nor AZURE_ENV_NAME is in the azd environment",
		);
		expect(calls).toEqual([]);
	},
);

test("the group's name is the template's own", () => {
	expect(
		readFileSync(join(import.meta.dir, "..", "infra", "main.bicep"), "utf8"),
	).toMatch(
		/resourceGroup: '\$\{abbreviations\.resourcesResourceGroups\}\$\{environmentName\}'/,
	);
	expect(
		JSON.parse(
			readFileSync(
				join(import.meta.dir, "..", "infra", "abbreviations.json"),
				"utf8",
			),
		).resourcesResourceGroups,
	).toBe("rg-");
});

eachTwin("any other refusal stops the hook and says why", (shell) => {
	const { exitCode, said, calls } = run(
		shell,
		{ AZURE_OPENAI_RESOURCE_NAME: "oai-x" },
		{ account: "refused" },
	);
	expect(exitCode).toBe(1);
	expect(said).toContain("AuthorizationFailed");
	expect(deletes(calls)).toEqual(["lock delete --ids lock-1"]);
});

eachTwin(
	"a lock that cannot be lifted, or a host that cannot be taken down, stops the hook",
	(shell) => {
		for (const refuse of ["lock delete", "resource delete"]) {
			const { exitCode } = run(
				shell,
				{ AZURE_OPENAI_RESOURCE_NAME: "oai-x" },
				{ refuse },
			);
			expect(exitCode, refuse).toBe(1);
		}
	},
);
