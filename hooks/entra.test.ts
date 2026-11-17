/**
 * entra with `az` and `azd` stood in for on PATH (and `sleep`, so a retried
 * call costs no time), each twin in turn. The stand-in `az` answers Microsoft Graph as a tenant
 * holding, or not holding, the registration `<env>-sign-in`; `refuse` makes
 * every call matching it answer as Graph answers a deployer who may not
 * register applications. What a test reads back: every az call (a request
 * body handed over as a file is read into its call, so both twins' calls read
 * alike), every value set into the azd environment, the roles file the
 * registration was made or completed with, and what the script said.
 */
import { expect } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eachTwin, runTwin, type Shell } from "./twins";

const SCRIPT = join(import.meta.dir, "entra");
const CALLBACK = "https://fd.example.net/api/auth/callback/microsoft-entra-id";
const ROLE_IDS: Record<string, string> = {
	user: "ca02a6f3-6ffc-4b88-aad4-8f0cced532d6",
	premium: "acb772d5-d73d-4432-86af-50b61225fa90",
	tester: "1b06d81d-62e8-4a52-a6da-a32ea2d41d49",
};

type Tenant = {
	userType?: string;
	/** The tenant az's selected subscription is in; the environment's is t1. */
	selectedTenant?: string;
	/** The registration already in the tenant under the script's name. */
	existing?: {
		owned: boolean;
		roles: string[];
		redirectUris: string[];
		displayName?: string;
		hasPrincipal?: boolean;
		/** Role values already assigned to the deployer. */
		assigned?: string[];
	};
	refuse?: string;
};

function run(
	shell: Shell,
	env: Record<string, string>,
	mode: string,
	tenant: Tenant = {},
	script = SCRIPT,
) {
	const bin = mkdtempSync(join(tmpdir(), "entra-"));
	const calls = join(bin, "calls");
	const sets = join(bin, "sets");
	const roles = join(bin, "roles");
	for (const file of [calls, sets]) writeFileSync(file, "");
	mkdirSync(roles);
	const existing = tenant.existing;
	const roleValues = existing?.roles ?? ["user", "premium", "tester"];
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub("sleep", "exit 0");
	stub("azd", `echo "$2 $3 $4" >> "${sets}"`);
	stub(
		"az",
		`line=""; before=""
for arg in "$@"; do
	shown="$arg"
	case "$arg" in @*)
		[ "$before" != "--app-roles" ] || cp "\${arg#@}" "${roles}/$(ls "${roles}" | wc -l | tr -d ' ')"
		[ "$before" != "--body" ] || shown="$(cat "\${arg#@}")" ;;
	esac
	line="\${line:+$line }$shown"; before="$arg"
done
echo "$line" >> "${calls}"
case "$*" in
${tenant.refuse ? `*"${tenant.refuse}"*) echo "ERROR: Insufficient privileges to complete the operation." >&2; exit 1 ;;` : ""}
*"--query user.type"*) echo ${tenant.userType ?? "user"} ;;
"account show --query tenantId"*) echo ${tenant.selectedTenant ?? "t1"} ;;
"account show --subscription sub --query tenantId"*) echo t1 ;;
"ad signed-in-user show"*) echo deployer-1 ;;
"ad app list"*) ${existing ? "echo app-found" : ":"} ;;
"ad app owner list"*) ${existing?.owned ? "echo deployer-1" : ":"} ;;
"ad app create"*) echo app-new ;;
*"--query displayName"*) echo ${existing?.displayName ?? "env-1-sign-in"} ;;
*"--query web.redirectUris"*) printf '%s\\n' ${(existing?.redirectUris ?? []).join(" ")} ;;
*"--query appRoles[].value"*) printf '%s\\n' ${roleValues.join(" ")} ;;
*"--query appRoles -o json"*) echo '${JSON.stringify(roleValues.map((value) => ({ value, id: ROLE_IDS[value] })))}' ;;
${Object.entries(ROLE_IDS)
	.map(([value, id]) => `*"appRoles[?value=='${value}'].id"*) echo ${id} ;;`)
	.join("\n")}
"ad sp show"*) ${existing?.hasPrincipal ? "echo sp-1" : "exit 1"} ;;
"ad sp create"*) echo sp-1 ;;
"ad app credential reset"*) echo s3cret ;;
"rest --method get"*) printf '%s\\n' ${(existing?.assigned ?? []).map((value) => ROLE_IDS[value]).join(" ")} ;;
esac`,
	);
	const result = runTwin(shell, script, script === SCRIPT ? [mode] : [], {
		PATH: `${bin}:${process.env.PATH}`,
		AZURE_SUBSCRIPTION_ID: "sub",
		AZURE_ENV_NAME: "env-1",
		FRONTEND_URL: "https://fd.example.net/",
		...env,
	});
	const lines = (file: string) =>
		readFileSync(file, "utf8").split("\n").filter(Boolean);
	return {
		...result,
		calls: lines(calls),
		sets: lines(sets),
		roles: readdirSync(roles)
			.sort((a, b) => Number(a) - Number(b))
			.map((file) => JSON.parse(readFileSync(join(roles, file), "utf8"))),
	};
}

const ENTRA = { AUTH_MODE: "entra" };
const graph = (calls: string[]) => calls.filter((c) => /^(ad|rest) /.test(c));

eachTwin(
	"a fresh Entra environment gets a registration with the three roles, the callback, the groups claim, a principal and a secret, and its deployer is assigned user and tester",
	(shell) => {
		const { exitCode, calls, sets, roles, said } = run(
			shell,
			ENTRA,
			"register",
		);
		expect(exitCode).toBe(0);
		expect(said).toContain("made the app registration env-1-sign-in");
		expect(calls).toContain(
			`ad app create --display-name env-1-sign-in --sign-in-audience AzureADMyOrg --app-roles @${calls.find((c) => c.startsWith("ad app create"))?.match(/@(\S+)/)?.[1]} --web-redirect-uris ${CALLBACK} --query appId -o tsv`,
		);
		expect(roles).toHaveLength(1);
		expect(
			roles[0].map((role: { value: string; id: string }) => [
				role.value,
				role.id,
			]),
		).toEqual(Object.entries(ROLE_IDS));
		for (const role of roles[0]) {
			expect(role.allowedMemberTypes).toEqual(["User"]);
			expect(role.isEnabled).toBe(true);
		}
		expect(calls).toContain(
			"ad app update --id app-new --set groupMembershipClaims=ApplicationGroup -o none",
		);
		expect(calls).toContain("ad sp create --id app-new --query id -o tsv");
		expect(calls).toContain(
			"ad app credential reset --id app-new --append --display-name azd --query password -o tsv",
		);
		expect(sets).toEqual([
			// The id last: an environment holding it is never asked again, so it
			// goes in once the secret it needs is beside it.
			"set AUTH_MICROSOFT_ENTRA_ID_SECRET s3cret",
			"set AUTH_MICROSOFT_ENTRA_ID_ID app-new",
		]);
		const posts = calls.filter((c) => c.startsWith("rest --method post"));
		expect(posts).toEqual(
			["user", "tester"].map(
				(value) =>
					`rest --method post --url https://graph.microsoft.com/v1.0/servicePrincipals/sp-1/appRoleAssignedTo --headers Content-Type=application/json --body {"principalId":"deployer-1","resourceId":"sp-1","appRoleId":"${ROLE_IDS[value]}"} -o none`,
			),
		);
	},
);

eachTwin(
	"hardened runs it whatever AUTH_MODE says; before the first provision there is no callback yet",
	(shell) => {
		const { exitCode, calls } = run(
			shell,
			{ HARDENED: "true", AUTH_MODE: "local", FRONTEND_URL: "" },
			"register",
		);
		expect(exitCode).toBe(0);
		const create = calls.find((c) => c.startsWith("ad app create"));
		expect(create).toBeDefined();
		expect(create).not.toContain("--web-redirect-uris");
	},
);

eachTwin(
	"a registration the deployer owns is completed, not duplicated: missing roles and callback added beside what it has",
	(shell) => {
		const { exitCode, calls, roles, sets } = run(shell, ENTRA, "register", {
			existing: {
				owned: true,
				roles: ["user"],
				redirectUris: ["https://old.example.net/cb"],
				hasPrincipal: true,
				assigned: ["user"],
			},
		});
		expect(exitCode).toBe(0);
		expect(calls.some((c) => c.startsWith("ad app create"))).toBe(false);
		expect(calls.some((c) => c.startsWith("ad sp create"))).toBe(false);
		expect(roles).toHaveLength(1);
		expect(roles[0].map((role: { value: string }) => role.value)).toEqual([
			"user",
			"premium",
			"tester",
		]);
		expect(calls).toContain(
			`ad app update --id app-found --web-redirect-uris https://old.example.net/cb ${CALLBACK} -o none`,
		);
		// A secret appended beside the ones it has, never a reset of them.
		expect(calls).toContain(
			"ad app credential reset --id app-found --append --display-name azd --query password -o tsv",
		);
		expect(sets[1]).toBe("set AUTH_MICROSOFT_ENTRA_ID_ID app-found");
		// user was assigned already; only tester is.
		expect(calls.filter((c) => c.startsWith("rest --method post"))).toEqual([
			expect.stringContaining(ROLE_IDS.tester),
		]);
	},
);

eachTwin(
	"a registration that has every role and the callback is left as it is",
	(shell) => {
		const { calls } = run(shell, ENTRA, "register", {
			existing: {
				owned: true,
				roles: ["user", "premium", "tester"],
				redirectUris: [CALLBACK],
				hasPrincipal: true,
				assigned: ["user", "tester"],
			},
		});
		expect(
			calls.filter(
				(c) =>
					c.startsWith("ad app update") && !c.includes("groupMembershipClaims"),
			),
		).toEqual([]);
		expect(calls.filter((c) => c.startsWith("rest --method post"))).toEqual([]);
	},
);

eachTwin(
	"a registration of that name somebody else owns is not taken over: a new one is made",
	(shell) => {
		const { calls } = run(shell, ENTRA, "register", {
			existing: { owned: false, roles: [], redirectUris: [] },
		});
		expect(calls.some((c) => c.startsWith("ad app create"))).toBe(true);
		expect(
			calls.filter(
				(c) =>
					c.includes("--id app-found") && !c.startsWith("ad app owner list"),
			),
		).toEqual([]);
	},
);

eachTwin(
	"where the vault already holds a client id, a registration of that name somebody else owns is the deployment's: nothing is made or set, and its id is named with the ways on",
	(shell) => {
		const { exitCode, calls, sets, said } = run(
			shell,
			{
				...ENTRA,
				KEY_VAULT_HOLDS: "auth-secret,entra-client-id,entra-client-secret",
			},
			"register",
			{ existing: { owned: false, roles: [], redirectUris: [] } },
		);
		expect(exitCode).toBe(0);
		expect(calls.some((c) => c.startsWith("ad app create"))).toBe(false);
		expect(calls.some((c) => c.startsWith("ad app credential"))).toBe(false);
		expect(sets).toEqual([]);
		expect(said).toContain("that you do not own (app-found)");
		expect(said).toContain("azd env set AUTH_MICROSOFT_ENTRA_ID_ID <appId>");
		// Not the report of an attempt that failed: nothing was tried.
		expect(said).not.toContain("was not finished");
	},
);

eachTwin(
	"a vault that holds other secrets and no client id is a first provision: the registration is made",
	(shell) => {
		const { calls, sets } = run(
			shell,
			{ ...ENTRA, KEY_VAULT_HOLDS: "auth-secret,not-entra-client-id" },
			"register",
			{ existing: { owned: false, roles: [], redirectUris: [] } },
		);
		expect(calls.some((c) => c.startsWith("ad app create"))).toBe(true);
		expect(sets).toContain("set AUTH_MICROSOFT_ENTRA_ID_ID app-new");
	},
);

eachTwin(
	"nothing is asked when the environment holds a client id, signs in locally, or opts out",
	(shell) => {
		for (const env of [
			{ ...ENTRA, AUTH_MICROSOFT_ENTRA_ID_ID: "app-kept" },
			{ AUTH_MODE: "local" },
			{},
			{ ...ENTRA, ENTRA_APP_SETUP: "false" },
			{ HARDENED: "true", ENTRA_APP_SETUP: "false" },
		]) {
			const { exitCode, calls, sets } = run(shell, env, "register");
			expect(exitCode).toBe(0);
			expect(calls).toEqual([]);
			expect(sets).toEqual([]);
		}
	},
);

eachTwin("the vault's placeholder counts as no client id", (shell) => {
	const { calls } = run(
		shell,
		{ ...ENTRA, AUTH_MICROSOFT_ENTRA_ID_ID: "unset" },
		"register",
	);
	expect(calls.some((c) => c.startsWith("ad app create"))).toBe(true);
});

eachTwin(
	"a pipeline's identity never asks Graph, and says how a pipeline is given the values",
	(shell) => {
		const { exitCode, calls, said } = run(shell, ENTRA, "register", {
			userType: "servicePrincipal",
		});
		expect(exitCode).toBe(0);
		expect(graph(calls)).toEqual([]);
		expect(said).toContain("set AUTH_MICROSOFT_ENTRA_ID_ID");
	},
);

eachTwin(
	"az pointed at another tenant stops before Graph, and says how to point it",
	(shell) => {
		const { exitCode, calls, said } = run(shell, ENTRA, "register", {
			selectedTenant: "t2",
		});
		expect(exitCode).toBe(1);
		expect(graph(calls)).toEqual([]);
		expect(said).toContain(
			'az account set --subscription "$(azd env get-value AZURE_SUBSCRIPTION_ID)"',
		);
		expect(said).not.toContain("sub,");
	},
);

eachTwin(
	"an az that cannot say who is signed in, or which tenant either subscription is in, stops the script before Graph: it is never read as a pipeline or as one tenant",
	(shell) => {
		for (const refuse of [
			"--query user.type",
			"account show --query tenantId",
			"account show --subscription sub --query tenantId",
		]) {
			const { exitCode, calls, sets, said } = run(shell, ENTRA, "register", {
				refuse,
			});
			expect(exitCode, refuse).toBe(1);
			expect(graph(calls), refuse).toEqual([]);
			expect(sets, refuse).toEqual([]);
			expect(said, refuse).toContain("entra: az account show --");
			expect(said, refuse).not.toContain("a pipeline's identity");
		}
	},
);

eachTwin(
	"a deployer Graph refuses is told the steps by hand, and nothing is set",
	(shell) => {
		const { exitCode, sets, said } = run(shell, ENTRA, "register", {
			refuse: "ad app create",
		});
		expect(exitCode).toBe(1);
		expect(sets).toEqual([]);
		expect(said).toContain("Insufficient privileges");
		expect(said).toContain(
			`az ad app create --display-name env-1-sign-in --sign-in-audience AzureADMyOrg --app-roles @approles.json --web-redirect-uris ${CALLBACK}`,
		);
		expect(said).toContain("ENTRA_APP_SETUP=false");
	},
);

eachTwin(
	"a refused role assignment keeps the registration's values and names only what is left",
	(shell) => {
		const { exitCode, sets, said } = run(shell, ENTRA, "register", {
			refuse: "rest --method post",
		});
		expect(exitCode).toBe(1);
		expect(sets).toHaveLength(2);
		expect(said).toContain("assign yourself the roles user and tester");
		expect(said).not.toContain("az ad app create");
	},
);

eachTwin(
	"redirect adds the callback to the registration this script names, and only to it",
	(shell) => {
		const env = { ...ENTRA, AUTH_MICROSOFT_ENTRA_ID_ID: "app-1" };
		const missing = run(shell, env, "redirect", {
			existing: { owned: true, roles: [], redirectUris: [] },
		});
		expect(missing.exitCode).toBe(0);
		expect(graph(missing.calls)).toEqual([
			"ad app show --id app-1 --query displayName -o tsv",
			"ad app show --id app-1 --query web.redirectUris -o tsv",
			`ad app update --id app-1 --web-redirect-uris ${CALLBACK} -o none`,
		]);
		const present = run(shell, env, "redirect", {
			existing: { owned: true, roles: [], redirectUris: [CALLBACK] },
		});
		expect(graph(present.calls)).toHaveLength(2);
		const theirs = run(shell, env, "redirect", {
			existing: {
				owned: true,
				roles: [],
				redirectUris: [],
				displayName: "their-app",
			},
		});
		expect(graph(theirs.calls)).toEqual([
			"ad app show --id app-1 --query displayName -o tsv",
		]);
		expect(run(shell, { ...ENTRA }, "redirect").calls).toEqual([]);
	},
);

eachTwin(
	"a lookup Graph refuses is a failure with the step by hand, never read as somebody else's registration",
	(shell) => {
		const redirect = run(
			shell,
			{ ...ENTRA, AUTH_MICROSOFT_ENTRA_ID_ID: "app-1" },
			"redirect",
			{
				existing: { owned: true, roles: [], redirectUris: [] },
				refuse: "--query displayName",
			},
		);
		expect(redirect.exitCode).toBe(1);
		expect(redirect.said).toContain(
			`add the redirect URI ${CALLBACK} to the registration`,
		);
		const owners = run(shell, ENTRA, "register", {
			existing: { owned: true, roles: [], redirectUris: [] },
			refuse: "ad app owner list",
		});
		expect(owners.exitCode).toBe(1);
		// Owners that cannot be read do not make a second registration.
		expect(owners.calls.some((c) => c.startsWith("ad app create"))).toBe(false);
		expect(owners.sets).toEqual([]);
	},
);

eachTwin(
	"postprovision calls it so that it cannot fail the provision",
	(shell) => {
		const { exitCode, said, calls } = run(
			shell,
			{ ...ENTRA, AUTH_MICROSOFT_ENTRA_ID_ID: "app-1" },
			"redirect",
			{
				existing: { owned: true, roles: [], redirectUris: [] },
				refuse: "--query displayName",
			},
			join(import.meta.dir, "postprovision"),
		);
		expect(exitCode).toBe(0);
		expect(calls).toContain(
			"ad app show --id app-1 --query displayName -o tsv",
		);
		expect(said).toContain(
			`add the redirect URI ${CALLBACK} to the registration`,
		);
	},
);

eachTwin(
	"a mode that is neither register nor redirect is refused before any call",
	(shell) => {
		const { exitCode, calls } = run(shell, ENTRA, "rename");
		expect(exitCode).toBe(1);
		expect(calls).toEqual([]);
	},
);
