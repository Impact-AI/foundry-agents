/**
 * postprovision.sh with `az` stood in for on PATH. Behind Front Door the hook
 * approves the edge's pending private link to the Container Apps
 * environment, and no other pending request; without Front Door it does
 * nothing. Every call names the
 * environment's subscription: without it, `az` reads the environment in
 * whichever subscription is selected on the machine, is refused
 * (`AuthorizationFailed … Microsoft.App/managedEnvironments/read over scope
 * /subscriptions/<default>/…`), and the approval then fails its usage check
 * with an empty id.
 */
import { expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eachTwin, runTwin, type Shell } from "./twins";

const HOOK = join(import.meta.dir, "postprovision");
const ENVIRONMENT_ID =
	"/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/cae-x";

function run(
	shell: Shell,
	env: Record<string, string>,
	options: {
		pending?: string[];
		refuse?: string;
		/** The category of the project's `insights` connection, or false for none. */
		insights?: string | false;
	} = {},
) {
	// Each pending request as the listing answers it: its id, then the message it was filed with.
	const pending = (
		options.pending ?? [
			`${ENVIRONMENT_ID}/privateEndpointConnections/pec-1\tfrontend`,
		]
	).join("\\n");
	const bin = mkdtempSync(join(tmpdir(), "postprovision-"));
	const calls = join(bin, "calls");
	writeFileSync(calls, "");
	writeFileSync(
		join(bin, "az"),
		`#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
${options.refuse ? `*"${options.refuse}"*) exit 1 ;;` : ""}
*"containerapp env show"*) echo "${ENVIRONMENT_ID}" ;;
*"private-endpoint-connection list"*) printf '${pending}\\n' ;;
*"name=='insights' && properties.category=='${options.insights === false ? "" : (options.insights ?? "AppInsights")}'"*) echo insights ;;
*"name=='insights'"*) ;;
*"rest --method get"*) printf 'chunks-kb\nchunks-kb-low\n' ;;
esac
`,
	);
	chmodSync(join(bin, "az"), 0o755);
	const result = runTwin(shell, HOOK, [], {
		PATH: `${bin}:${process.env.PATH}`,
		AZURE_RESOURCE_GROUP: "rg",
		AZURE_CONTAINER_APPS_ENVIRONMENT_NAME: "cae-x",
		...env,
	});
	return {
		...result,
		calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
	};
}

eachTwin(
	"behind Front Door, reads the environment and approves each pending link, every call in the environment's subscription",
	(shell) => {
		const { exitCode, calls } = run(shell, {
			FRONT_DOOR_ENDPOINT: "x.azurefd.net",
			AZURE_SUBSCRIPTION_ID: "sub",
		});
		expect(exitCode).toBe(0);
		expect(calls).toEqual([
			"containerapp env show --subscription sub -g rg -n cae-x --query id -o tsv",
			`network private-endpoint-connection list --subscription sub --id ${ENVIRONMENT_ID} --query [?properties.privateLinkServiceConnectionState.status=='Pending'].[id, properties.privateLinkServiceConnectionState.description] -o tsv`,
			`network private-endpoint-connection approve --subscription sub --id ${ENVIRONMENT_ID}/privateEndpointConnections/pec-1 --description front door -o none`,
		]);
	},
);

eachTwin(
	"only the edge's request is approved: a pending request filed with another message is left pending and named",
	(shell) => {
		const theirs = `${ENVIRONMENT_ID}/privateEndpointConnections/pec-theirs`;
		const { exitCode, calls, said } = run(
			shell,
			{ FRONT_DOOR_ENDPOINT: "x.azurefd.net", AZURE_SUBSCRIPTION_ID: "sub" },
			{
				pending: [
					`${theirs}\tsomebody else`,
					`${ENVIRONMENT_ID}/privateEndpointConnections/pec-1\tfrontend`,
				],
			},
		);
		expect(exitCode).toBe(0);
		expect(calls.filter((call) => call.includes(" approve "))).toEqual([
			`network private-endpoint-connection approve --subscription sub --id ${ENVIRONMENT_ID}/privateEndpointConnections/pec-1 --description front door -o none`,
		]);
		expect(said).toContain(
			`left pending a private link request that is not the edge's ("somebody else"): ${theirs}. If it is yours: az network private-endpoint-connection approve --subscription sub --id ${theirs}`,
		);
	},
);

eachTwin(
	"the message the hook matches is the one the template gives the edge's origin",
	(shell) => {
		expect(
			readFileSync(
				join(import.meta.dir, "..", "infra", "modules", "edge.bicep"),
				"utf8",
			),
		).toContain("requestMessage: 'frontend'");
		// A request filed with the same word in another case is not the edge's.
		const { calls } = run(
			shell,
			{ FRONT_DOOR_ENDPOINT: "x.azurefd.net", AZURE_SUBSCRIPTION_ID: "sub" },
			{
				pending: [
					`${ENVIRONMENT_ID}/privateEndpointConnections/pec-2\tFrontend`,
				],
			},
		);
		expect(calls.filter((call) => call.includes(" approve "))).toEqual([]);
	},
);

eachTwin(
	"without Front Door there is nothing to approve, and nothing is asked",
	(shell) => {
		const { exitCode, calls } = run(shell, { AZURE_SUBSCRIPTION_ID: "sub" });
		expect(exitCode).toBe(0);
		expect(calls).toEqual([]);
	},
);

eachTwin(
	"an environment naming no subscription stops before any call, rather than asking az's default",
	(shell) => {
		const { exitCode, said, calls } = run(shell, {
			FRONT_DOOR_ENDPOINT: "x.azurefd.net",
		});
		expect(exitCode).toBe(1);
		expect(said).toContain(
			"AZURE_SUBSCRIPTION_ID is not in the azd environment",
		);
		expect(calls).toEqual([]);
	},
);

eachTwin(
	"an environment that cannot be read, or a link that cannot be approved, stops the hook",
	(shell) => {
		for (const refuse of ["containerapp env show", " approve "]) {
			const { exitCode } = run(
				shell,
				{ FRONT_DOOR_ENDPOINT: "x.azurefd.net", AZURE_SUBSCRIPTION_ID: "sub" },
				{ refuse },
			);
			expect(exitCode, refuse).toBe(1);
		}
	},
);

eachTwin(
	"deletes each project connection to a knowledge base's MCP endpoint, by the project the environment names, and reads nothing without one",
	(shell) => {
		const project =
			"https://management.azure.com/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/oai-x/projects/agent/connections";
		const { exitCode, calls, said } = run(shell, {
			AZURE_SUBSCRIPTION_ID: "sub",
			AZURE_OPENAI_RESOURCE_NAME: "oai-x",
			FOUNDRY_PROJECT_ENDPOINT:
				"https://oai-x.services.ai.azure.com/api/projects/agent",
		});
		expect(exitCode).toBe(0);
		expect(calls.slice(0, 3)).toEqual([
			`rest --method get --url ${project}?api-version=2025-10-01-preview --query value[?properties.category=='RemoteTool' && contains(properties.target, '/knowledgebases/')].name -o tsv`,
			`rest --method delete --url ${project}/chunks-kb?api-version=2025-10-01-preview -o none`,
			`rest --method delete --url ${project}/chunks-kb-low?api-version=2025-10-01-preview -o none`,
		]);
		expect(said).toContain(
			"postprovision: deleted the project connection chunks-kb, to a knowledge base's MCP endpoint",
		);
	},
);

eachTwin(
	"a connection that could not be deleted is said to be left, never said to be deleted, and the provision goes on",
	(shell) => {
		const env = {
			AZURE_SUBSCRIPTION_ID: "sub",
			AZURE_OPENAI_RESOURCE_NAME: "oai-x",
			FOUNDRY_PROJECT_ENDPOINT:
				"https://oai-x.services.ai.azure.com/api/projects/agent",
		};
		const { exitCode, calls, said } = run(shell, env, {
			refuse: "rest --method delete",
		});
		expect(exitCode).toBe(0);
		expect(
			calls.filter(
				(call) =>
					call.includes("--method delete") && call.includes("chunks-kb"),
			),
		).toHaveLength(2);
		expect(said).not.toContain("deleted the project connection");
		for (const name of ["chunks-kb", "chunks-kb-low"])
			expect(said).toContain(
				`the project connection ${name}, to a knowledge base's MCP endpoint, could not be deleted`,
			);
		const unread = run(shell, env, { refuse: "rest --method get" });
		expect(unread.exitCode).toBe(0);
		expect(unread.said).toContain("could not be read");
		expect(
			unread.calls.filter((call) => call.includes("--method delete")),
		).toEqual([]);
	},
);

const PROJECT = {
	AZURE_SUBSCRIPTION_ID: "sub",
	AZURE_OPENAI_RESOURCE_NAME: "oai-x",
	FOUNDRY_PROJECT_ENDPOINT:
		"https://oai-x.services.ai.azure.com/api/projects/agent",
};
const CONNECTIONS =
	"https://management.azure.com/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/oai-x/projects/agent/connections";
const DELETE_INSIGHTS = `rest --method delete --url ${CONNECTIONS}/insights?api-version=2025-10-01-preview -o none`;

eachTwin(
	"with AGENT_TRACING off, an Application Insights connection a deployment already has is deleted, since the template's condition never removes it",
	(shell) => {
		for (const tracing of [undefined, "false"]) {
			const { exitCode, calls, said } = run(shell, {
				...PROJECT,
				...(tracing === undefined ? {} : { AGENT_TRACING: tracing }),
			});
			expect(exitCode).toBe(0);
			expect(calls.slice(3)).toEqual([
				`rest --method get --url ${CONNECTIONS}?api-version=2025-10-01-preview --query value[?name=='insights' && properties.category=='AppInsights'].name -o tsv`,
				DELETE_INSIGHTS,
			]);
			expect(said).toContain("deleted the project connection insights");
		}
	},
);

eachTwin(
	"with AGENT_TRACING on, the Application Insights connection is the template's and is left alone",
	(shell) => {
		for (const tracing of ["true", "True"]) {
			const { exitCode, calls } = run(shell, {
				...PROJECT,
				AGENT_TRACING: tracing,
			});
			expect(exitCode).toBe(0);
			expect(calls.filter((call) => call.includes("insights"))).toEqual([]);
		}
	},
);

eachTwin(
	"a project with no Application Insights connection named insights has nothing deleted, and one that cannot be read or deleted is named without failing the provision",
	(shell) => {
		const none = run(shell, PROJECT, { insights: false });
		expect(none.exitCode).toBe(0);
		expect(none.calls).not.toContain(DELETE_INSIGHTS);
		expect(none.said).not.toContain("insights");

		// A connection named insights that is not Application Insights is somebody else's.
		const other = run(shell, PROJECT, { insights: "CustomKeys" });
		expect(other.exitCode).toBe(0);
		expect(other.calls).not.toContain(DELETE_INSIGHTS);

		const unread = run(shell, PROJECT, {
			refuse: "properties.category=='AppInsights'",
		});
		expect(unread.exitCode).toBe(0);
		expect(unread.calls).not.toContain(DELETE_INSIGHTS);
		expect(unread.said).toContain("could not be read to check for insights");

		const refused = run(shell, PROJECT, { refuse: "insights?api-version" });
		expect(refused.exitCode).toBe(0);
		expect(refused.calls).toContain(DELETE_INSIGHTS);
		expect(refused.said).not.toContain(
			"deleted the project connection insights",
		);
		expect(refused.said).toContain(
			"the project connection insights could not be deleted",
		);
	},
);
