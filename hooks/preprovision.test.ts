/**
 * preprovision.sh with `azd` and `az` stood in for on PATH. The stand-in `azd`
 * prints a missing key's error on stdout, as azd 1.20 does, which is what a
 * hook reading `azd env get-value` once mistook for a value. The stand-in
 * `az` refuses Microsoft Graph, as a pipeline's identity with no Graph read
 * is refused, says which resource providers the subscription has
 * registered, which SKUs of the realtime model the region offers, and which
 * secrets the environment's vault holds. Every scenario runs through both
 * twins on the same stand-ins (hooks/twins.ts).
 */
import { expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPONENTS, refusals } from "../apps/backend/src/components";
import { eachTwin, runTwin, type Shell } from "./twins";

const HOOK = join(import.meta.dir, "preprovision");

/**
 * The address ARM gives for the page after the first, and for each after
 * that: the same list, with the token that asks for the page.
 */
const nextPage = (n: number) =>
	`https://management.azure.com/secrets?api-version=2023-07-01&$skiptoken=${pageToken(n)}`;
/** A token as ARM writes it into an address: with what an address cannot hold escaped. */
const pageToken = (n: number) => `page%2F${n}%3D%3D`;
/** The same token as the hook hands it back, a parameter of its own. */
const askedWith = (n: number) => `$skiptoken=page/${n}==`;

/**
 * The stand-in's answer to `az rest`, as the hook's query shapes it: the next
 * page's address on the first line, empty on the last page, then one name a
 * line. Which page is asked for is read from the address.
 */
function restAnswers(pages: string[][] | "loop" | null): string {
	if (pages === null) return "echo 'ERROR: AuthorizationFailed' >&2; exit 1";
	// A page that names itself: whatever is asked, the next page is the same one.
	if (pages === "loop") return `echo '${nextPage(2)}'; echo auth-secret`;
	const answer = (names: string[], next: string) =>
		`printf '%s\\n' '${next}' ${names.map((name) => `'${name}'`).join(" ")}`;
	const later = pages
		.slice(1)
		.map(
			(names, i) =>
				`*'${askedWith(i + 2)}'*) ${answer(names, i + 2 < pages.length ? nextPage(i + 3) : "")} ;;`,
		)
		.join("\n\t");
	return `case "$*" in
	${later}
	*) ${answer(pages[0] ?? [], pages.length > 1 ? nextPage(2) : "")} ;;
	esac`;
}

function run(
	shell: Shell,
	env: Record<string, string>,
	options: {
		userType?: string;
		registered?: string[];
		/** The realtime model's SKUs the region offers; null is az failing to answer. */
		offered?: string[] | null;
		/** The secrets the environment's vault holds; null is a vault ARM will not list; absent, no resource group yet. */
		vault?: string[] | null;
		/** The same list as the pages ARM answers it in, each naming the next; `loop` is a page that names itself. */
		pages?: string[][] | "loop";
		/** The azd-service-name tags of the container apps the group holds; null is a list ARM refuses. */
		apps?: string[] | null;
		/** A call that fails: azd setting the named variable, or az registering a provider. */
		failing?: { set?: string; register?: boolean };
		/** Stand in for ssh-keygen, recording the passphrase it is handed. */
		keygen?: boolean;
	} = {},
) {
	const bin = mkdtempSync(join(tmpdir(), "preprovision-"));
	const sets = join(bin, "sets");
	const lookups = join(bin, "lookups");
	const providers = join(bin, "providers");
	const models = join(bin, "models");
	const asked = join(bin, "asked");
	const passphrase = join(bin, "passphrase");
	writeFileSync(asked, "");
	writeFileSync(passphrase, "");
	writeFileSync(models, "");
	writeFileSync(sets, "");
	writeFileSync(lookups, "");
	writeFileSync(providers, "");
	const registered = (options.registered ?? [])
		.map((namespace) => `*"-n ${namespace} "*) echo Registered ;;`)
		.join("\n");
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub(
		"azd",
		`if [ "$2" = "get-value" ]; then echo; echo "ERROR: key '$3' not found in the environment values"; exit 1; fi
${options.failing?.set ? `if [ "$3" = "${options.failing.set}" ]; then echo "ERROR: refused" >&2; exit 1; fi` : ""}
echo "$2 $3 $4" >> "${sets}"`,
	);
	stub(
		"az",
		`case "$*" in
"provider "*) echo "$*" >> "${providers}"
	case "$*" in
	${options.failing?.register ? `"provider register"*) echo "ERROR: refused" >&2; exit 1 ;;` : ""}
	"provider show"*)
		case "$*" in
		${registered}
		*) echo NotRegistered ;;
		esac ;;
	esac ;;
*user.type*) echo ${options.userType ?? "user"} ;;
"cognitiveservices model list"*) echo "$*" >> "${models}"
	${
		options.offered === null
			? "echo 'ERROR: something went wrong' >&2; exit 1"
			: `printf '%s\\n' ${(options.offered ?? ["GlobalStandard", "DataZoneStandard"]).join(" ")}`
	} ;;
"group exists"*) echo "$*" >> "${asked}"; echo ${options.vault === undefined && options.pages === undefined && options.apps === undefined ? "false" : "true"} ;;
"resource list"*Microsoft.KeyVault/vaults*) echo "$*" >> "${asked}"; echo kv-sample ;;
"resource list"*Microsoft.App/containerApps*) echo "$*" >> "${asked}"
	${
		options.apps === null
			? "echo 'ERROR: AuthorizationFailed' >&2; exit 1"
			: // Every app's tags, whole, as `-o json` prints them: one with other tags, and one with none.
				`cat <<'JSON'
${JSON.stringify(
	[
		...(options.apps ?? []).map((tag) => ({
			"azd-env-name": "sample",
			"azd-service-name": tag,
		})),
		null,
	],
	null,
	2,
)}
JSON
`
	} ;;
"rest "*) echo "$*" >> "${asked}"
	${restAnswers(options.pages ?? (options.vault ? [options.vault] : null))} ;;
"ad "*) echo "$*" >> "${lookups}"; echo 'Insufficient privileges' >&2; exit 1 ;;
esac`,
	);
	// The passphrase is the argument after -N, written between brackets so an
	// empty one and a missing one read differently; the key is a line of the
	// form the real one writes.
	if (options.keygen)
		stub(
			"ssh-keygen",
			`while [ "$#" -gt 0 ]; do
	case "$1" in
	-N) printf '[%s]' "$2" > "${passphrase}"; shift ;;
	-f) echo "ssh-ed25519 AAAAstandin jump-host" > "$2.pub"; : > "$2"; shift ;;
	esac
	shift
done`,
		);
	const result = runTwin(shell, HOOK, [], {
		PATH: `${bin}:${process.env.PATH}`,
		AZURE_SUBSCRIPTION_ID: "sub",
		AZURE_LOCATION: "swedencentral",
		...env,
	});
	const lines = (file: string) =>
		readFileSync(file, "utf8")
			.split("\n")
			.map((line) => line.trimEnd())
			.filter(Boolean);
	return {
		...result,
		passphrase: options.keygen ? readFileSync(passphrase, "utf8") : undefined,
		models: lines(models),
		asked: lines(asked),
		sets: lines(sets),
		lookups: lines(lookups),
		providers: lines(providers),
	};
}

const secretSets = (sets: string[]) =>
	sets.filter((c) => /^set AUTH_SECRET /.test(c)).map((c) => c.split(" ")[1]);

eachTwin(
	"generates the session secret when the environment has none",
	(shell) => {
		const { exitCode, sets } = run(shell, {});
		expect(exitCode).toBe(0);
		expect(secretSets(sets)).toEqual(["AUTH_SECRET"]);
		for (const c of sets.filter((c) => c.includes("SECRET")))
			expect(c.split(" ")[2]).toMatch(/^[0-9a-f]{64}$/);
	},
);

eachTwin("keeps secrets the environment already holds", (shell) => {
	const { sets } = run(shell, { AUTH_SECRET: "kept" });
	expect(secretSets(sets)).toEqual([]);
});

eachTwin(
	"a machine with no session secret makes none while the vault holds one: a second machine or a pipeline signs nobody out",
	(shell) => {
		const held = run(
			shell,
			{ AZURE_ENV_NAME: "sample" },
			{ vault: ["entra-issuer", "auth-secret"] },
		);
		expect(held.exitCode).toBe(0);
		expect(secretSets(held.sets)).toEqual([]);
		// A vault that holds other secrets and not this one has no session secret to keep.
		const without = run(
			shell,
			{ AZURE_ENV_NAME: "sample" },
			{ vault: ["entra-issuer", "not-auth-secret"] },
		);
		expect(secretSets(without.sets)).toEqual(["AUTH_SECRET"]);
		// What the vault holds is known before the secret is decided.
		const order = held.sets.map((c) => c.split(" ")[1]);
		expect(order.indexOf("KEY_VAULT_HOLDS")).toBeGreaterThanOrEqual(0);
	},
);

// ssh-keygen is stood in for, so the case runs wherever the suite does and
// the passphrase each twin hands it can be read: an empty one, not a pair of
// quotation marks.
eachTwin(
	"developer access gets a VM key once, made with no passphrase, the public half only; without it nothing is made",
	(shell) => {
		const keyed = run(shell, { DEVELOPER_ACCESS: "true" }, { keygen: true });
		expect(keyed.exitCode).toBe(0);
		expect(keyed.passphrase).toBe("[]");
		expect(
			keyed.sets.filter((c) => c.startsWith("set DEVELOPER_ACCESS_SSH_KEY ")),
		).toEqual([
			"set DEVELOPER_ACCESS_SSH_KEY ssh-ed25519 AAAAstandin jump-host",
		]);
		expect(
			run(
				shell,
				{ DEVELOPER_ACCESS: "true", DEVELOPER_ACCESS_SSH_KEY: "kept" },
				{ keygen: true },
			).sets,
		).not.toContainEqual(expect.stringContaining("DEVELOPER_ACCESS_SSH_KEY"));
		expect(run(shell, {}, { keygen: true }).sets).not.toContainEqual(
			expect.stringContaining("DEVELOPER_ACCESS_SSH_KEY"),
		);
		// The switch is read exactly, as every other one is.
		expect(
			run(shell, { DEVELOPER_ACCESS: "True" }, { keygen: true }).sets,
		).not.toContainEqual(expect.stringContaining("DEVELOPER_ACCESS_SSH_KEY"));
	},
);

eachTwin(
	"the principal is typed as a person or a pipeline, and Microsoft Graph is never asked",
	(shell) => {
		const user = run(shell, {});
		expect(user.exitCode).toBe(0);
		expect(user.sets).toContain("set AZURE_PRINCIPAL_TYPE User");
		const pipeline = run(shell, {}, { userType: "servicePrincipal" });
		expect(pipeline.exitCode).toBe(0);
		expect(pipeline.sets).toContain(
			"set AZURE_PRINCIPAL_TYPE ServicePrincipal",
		);
		expect([...user.lookups, ...pipeline.lookups]).toEqual([]);
	},
);

const registrations = (providers: string[]) =>
	providers.filter((c) => c.startsWith("provider register"));

eachTwin(
	"registers the providers the Agent Service's injection needs, and waits for them",
	(shell) => {
		const { exitCode, providers } = run(shell, {});
		expect(exitCode).toBe(0);
		expect(registrations(providers)).toEqual([
			"provider register --subscription sub -n Microsoft.App --wait -o none",
			"provider register --subscription sub -n Microsoft.ContainerService --wait -o none",
		]);
	},
);

eachTwin(
	"a provider the subscription has registered is left alone",
	(shell) => {
		const { providers } = run(shell, {}, { registered: ["Microsoft.App"] });
		expect(registrations(providers)).toEqual([
			"provider register --subscription sub -n Microsoft.ContainerService --wait -o none",
		]);
	},
);

eachTwin(
	"a region that offers the realtime model at the parameter file's SKU passes, asked about that model and version",
	(shell) => {
		const { exitCode, models } = run(shell, {});
		expect(exitCode).toBe(0);
		expect(models).toEqual([
			"cognitiveservices model list --subscription sub -l swedencentral --query [?model.name=='gpt-realtime-2.1' && model.version=='2026-07-07'].model.skus[].name -o tsv",
		]);
	},
);

eachTwin(
	"a region that does not offer it is refused before anything is made, naming both ways through",
	(shell) => {
		const none = run(shell, { AZURE_LOCATION: "westeurope" }, { offered: [] });
		expect(none.exitCode).toBe(1);
		expect(none.stderr).toContain(
			"westeurope does not offer gpt-realtime-2.1 2026-07-07 as GlobalStandard",
		);
		expect(none.stderr).toContain("azd env set AZURE_LOCATION <region>");
		expect(none.stderr).toContain('take "realtime" out of models');
		expect(none.sets).not.toContainEqual(
			expect.stringContaining("AZURE_PRINCIPAL_TYPE"),
		);
		// Another SKU of the model is not the parameter file's.
		expect(run(shell, {}, { offered: ["DataZoneStandard"] }).exitCode).toBe(1);
	},
);

eachTwin(
	"a region az cannot be asked about is reported, not refused",
	(shell) => {
		// A warning is bash's stderr and PowerShell's warning stream; what is said is the same.
		const { exitCode, said } = run(shell, {}, { offered: null });
		expect(exitCode).toBe(0);
		expect(said).toContain("could not ask swedencentral");
	},
);

eachTwin("with no location yet, the region is not asked about", (shell) => {
	const { exitCode, models } = run(shell, { AZURE_LOCATION: "" });
	expect(exitCode).toBe(0);
	expect(models).toEqual([]);
});

// --- components chosen at deploy time ------------------------------------

const refusedLines = (stderr: string) =>
	stderr
		.split("\n")
		.filter((line) => line.startsWith("preprovision: "))
		.map((line) => line.slice("preprovision: ".length));

eachTwin(
	"every rule, each side of it and each network switch, is refused exactly as the job's table refuses it, before anything is made",
	(shell) => {
		const networks = [
			{ PRIVATE_NETWORKING: "", HARDENED: "" },
			{ PRIVATE_NETWORKING: "true", HARDENED: "" },
			{ PRIVATE_NETWORKING: "", HARDENED: "true" },
			// Zones go with the network, so the bundle without it switches them off too.
			{
				PRIVATE_NETWORKING: "false",
				HARDENED: "true",
				ZONE_REDUNDANT: "false",
			},
		];
		const cases = [
			{ MEMORY_STORE: "foundry", RETRIEVAL_ENGINE: "knowledgeBase" },
			{ MEMORY_STORE: "own", RETRIEVAL_ENGINE: "knowledgeBase" },
			{ MEMORY_STORE: "", RETRIEVAL_ENGINE: "hybrid" },
			{ MEMORY_STORE: "bogus", RETRIEVAL_ENGINE: "bogus" },
		];
		for (const network of networks)
			for (const component of cases) {
				const env = { ...network, ...component };
				const choices = Object.fromEntries(
					Object.entries({
						MEMORY_STORE: component.MEMORY_STORE,
						RETRIEVAL_ENGINE: component.RETRIEVAL_ENGINE,
					}).filter(([, v]) => v),
				);
				const expected = refusals(choices, {
					private:
						network.PRIVATE_NETWORKING === "true" ||
						(network.PRIVATE_NETWORKING === "" && network.HARDENED === "true"),
				});
				const hook = run(shell, env);
				expect({ env, refused: refusedLines(hook.stderr) }).toEqual({
					env,
					refused: expected,
				});
				expect(hook.exitCode).toBe(expected.length ? 1 : 0);
				if (expected.length) {
					expect(hook.sets).toEqual([]);
					expect(hook.providers).toEqual([]);
				}
			}
	},
	60_000,
);

eachTwin(
	"an unknown history store or voice engine is refused in the job's words",
	(shell) => {
		for (const variable of ["HISTORY_STORE", "VOICE_ENGINE"]) {
			const hook = run(shell, { [variable]: "bogus" });
			expect(hook.exitCode).toBe(1);
			expect(refusedLines(hook.stderr)).toEqual(
				refusals({ [variable]: "bogus" }, { private: false }),
			);
		}
	},
	30_000,
);

eachTwin(
	"a private deploy with the Foundry memory store fails, a public one passes, a private one with own passes",
	(shell) => {
		const closed = run(shell, {
			PRIVATE_NETWORKING: "true",
			MEMORY_STORE: "foundry",
		});
		expect(closed.exitCode).toBe(1);
		expect(closed.stderr).toContain("MEMORY_STORE=own");
		expect(run(shell, { MEMORY_STORE: "foundry" }).exitCode).toBe(0);
		expect(
			run(shell, { PRIVATE_NETWORKING: "true", MEMORY_STORE: "own" }).exitCode,
		).toBe(0);
	},
	30_000,
);

eachTwin(
	"every value the job's table allows a component is one the hook allows, and one outside it is refused by name",
	(shell) => {
		for (const component of COMPONENTS) {
			for (const value of component.values) {
				const env = { [component.variable]: value };
				const hook = run(shell, env);
				expect({ env, refused: refusedLines(hook.stderr) }).toEqual({
					env,
					refused: refusals(env, { private: false }),
				});
			}
			const env = { [component.variable]: "bogus" };
			expect({ env, refused: refusedLines(run(shell, env).stderr) }).toEqual({
				env,
				refused: refusals(env, { private: false }),
			});
		}
	},
	120_000,
);

// --- zones go with the network ---------------------------------------------

eachTwin(
	"zone redundancy without the network is refused before anything is made, set or through HARDENED",
	(shell) => {
		for (const env of [
			{ ZONE_REDUNDANT: "true" },
			{ ZONE_REDUNDANT: "true", HARDENED: "true", PRIVATE_NETWORKING: "false" },
			{ HARDENED: "true", PRIVATE_NETWORKING: "false" },
		]) {
			const hook = run(shell, env);
			expect({ env, exitCode: hook.exitCode }).toEqual({ env, exitCode: 1 });
			expect(refusedLines(hook.stderr)).toEqual([
				expect.stringMatching(/^deployment\.zones_need_network: /),
			]);
			expect(hook.stderr).toContain("azd env set ZONE_REDUNDANT false");
			expect(hook.stderr).toContain("PRIVATE_NETWORKING=true");
			expect(hook.sets).toEqual([]);
			expect(hook.providers).toEqual([]);
		}
	},
	60_000,
);

eachTwin(
	"zones with the network, and no zones, pass",
	(shell) => {
		for (const env of [
			{},
			{ HARDENED: "true" },
			{ ZONE_REDUNDANT: "true", PRIVATE_NETWORKING: "true" },
			{
				HARDENED: "true",
				PRIVATE_NETWORKING: "false",
				ZONE_REDUNDANT: "false",
			},
			{ HARDENED: "true", ZONE_REDUNDANT: "false" },
		])
			expect({ env, exitCode: run(shell, env).exitCode }).toEqual({
				env,
				exitCode: 0,
			});
	},
	60_000,
);

// --- what the vault holds --------------------------------------------------

const holds = (sets: string[]) =>
	sets
		.filter((c) => c.startsWith("set KEY_VAULT_HOLDS "))
		.map((c) => c.split(" ")[2]);

eachTwin(
	"an environment that has made nothing holds no secret, and the vault is never asked",
	(shell) => {
		const hook = run(shell, { AZURE_ENV_NAME: "sample" });
		expect(hook.exitCode).toBe(0);
		expect(holds(hook.sets)).toEqual(["none"]);
		expect(hook.asked).toEqual([
			"group exists --subscription sub -n rg-sample",
		]);
	},
);

eachTwin(
	"the secrets the vault holds are asked of Azure Resource Manager, in the environment's subscription and group, and handed to the template",
	(shell) => {
		const hook = run(
			shell,
			{ AZURE_ENV_NAME: "sample" },
			{
				vault: ["auth-secret", "entra-client-id", "entra-client-secret"],
			},
		);
		expect(hook.exitCode).toBe(0);
		expect(holds(hook.sets)).toEqual([
			"auth-secret,entra-client-id,entra-client-secret",
		]);
		expect(hook.asked).toEqual([
			"group exists --subscription sub -n rg-sample",
			"resource list --subscription sub -g rg-sample --resource-type Microsoft.KeyVault/vaults --query [0].name -o tsv",
			"rest --method get --url /subscriptions/sub/resourceGroups/rg-sample/providers/Microsoft.KeyVault/vaults/kv-sample/secrets --url-parameters api-version=2023-07-01 --query [nextLink || '', value[].name][] -o tsv",
			"resource list --subscription sub -g rg-sample --resource-type Microsoft.App/containerApps --query [].tags -o json",
		]);
	},
);

eachTwin(
	"a list the vault answers a page at a time is read to its last page, so a secret on a later page is still held",
	(shell) => {
		const hook = run(
			shell,
			{ AZURE_ENV_NAME: "sample" },
			{
				pages: [
					["operator-one", "operator-two"],
					["operator-three"],
					["auth-secret", "entra-client-id"],
				],
			},
		);
		expect(hook.exitCode).toBe(0);
		expect(holds(hook.sets)).toEqual([
			"operator-one,operator-two,operator-three,auth-secret,entra-client-id",
		]);
		expect(secretSets(hook.sets)).toEqual([]);
		// Each later page is asked for by its token, unescaped, and never by
		// the address that named it: no argument carries an ampersand.
		const asked = hook.asked.filter((c) => c.startsWith("rest "));
		expect(
			asked.map(
				(c) => c.replace(/^.*--url-parameters /, "").split(" --query")[0],
			),
		).toEqual([
			"api-version=2023-07-01",
			`api-version=2023-07-01 ${askedWith(2)}`,
			`api-version=2023-07-01 ${askedWith(3)}`,
		]);
		expect(asked.join("\n")).not.toContain("&");
	},
);

eachTwin(
	"a page that names itself as the next stops the provision: what the vault holds is not known",
	(shell) => {
		const hook = run(shell, { AZURE_ENV_NAME: "sample" }, { pages: "loop" });
		expect(hook.exitCode).not.toBe(0);
		expect(hook.stderr).toContain("names the page just read as the next one");
		expect(holds(hook.sets)).toEqual([]);
	},
);

eachTwin(
	"the group the environment names wins over the derived one, and an empty vault holds none",
	(shell) => {
		const hook = run(
			shell,
			{ AZURE_ENV_NAME: "sample", AZURE_RESOURCE_GROUP: "rg-named" },
			{ vault: [] },
		);
		expect(hook.exitCode).toBe(0);
		expect(holds(hook.sets)).toEqual(["none"]);
		expect(hook.asked[0]).toBe("group exists --subscription sub -n rg-named");
	},
);

eachTwin(
	"a vault that cannot be asked stops the provision, which would otherwise replace what it holds",
	(shell) => {
		const hook = run(shell, { AZURE_ENV_NAME: "sample" }, { vault: null });
		expect(hook.exitCode).not.toBe(0);
		expect(hook.stderr).toContain(
			"could not ask which secrets the vault kv-sample holds",
		);
		expect(holds(hook.sets)).toEqual([]);
		expect(hook.sets).not.toContainEqual(
			expect.stringContaining("AZURE_PRINCIPAL_TYPE"),
		);
	},
);

// --- which services run ----------------------------------------------------

const runs = (sets: string[]) =>
	sets
		.filter((c) => c.startsWith("set SERVICES_RUNNING "))
		.map((c) => c.split(" ")[2]);

eachTwin(
	"the services whose container app exists are handed to the template, whatever else the group's apps are tagged",
	(shell) => {
		expect(runs(run(shell, { AZURE_ENV_NAME: "sample" }).sets)).toEqual([
			"none",
		]);
		expect(
			runs(
				run(shell, { AZURE_ENV_NAME: "sample" }, { vault: [], apps: [] }).sets,
			),
		).toEqual(["none"]);
		expect(
			runs(
				run(
					shell,
					{ AZURE_ENV_NAME: "sample" },
					{ vault: [], apps: ["frontend", "None", "backend", "other"] },
				).sets,
			),
		).toEqual(["backend,frontend"]);
		expect(
			runs(
				run(
					shell,
					{ AZURE_ENV_NAME: "sample" },
					{ vault: [], apps: ["Backend", "frontend"] },
				).sets,
			),
		).toEqual(["frontend"]);
	},
);

eachTwin(
	"container apps that cannot be listed stop the provision, which could otherwise put the placeholder over a running app",
	(shell) => {
		const hook = run(
			shell,
			{ AZURE_ENV_NAME: "sample" },
			{ vault: [], apps: null },
		);
		expect(hook.exitCode).not.toBe(0);
		expect(hook.stderr).toContain(
			"could not ask which container apps the resource group rg-sample holds",
		);
		expect(runs(hook.sets)).toEqual([]);
		expect(hook.sets).not.toContainEqual(
			expect.stringContaining("AZURE_PRINCIPAL_TYPE"),
		);
	},
);

// --- a call that fails stops the hook ---------------------------------------

eachTwin(
	"a variable azd will not set, or a provider that will not register, stops the hook before the principal is typed",
	(shell) => {
		// Each twin says which call it was, in the hook's own words.
		for (const [failing, said] of [
			[
				{ set: "AUTH_SECRET" },
				"could not set AUTH_SECRET in the azd environment",
			],
			[
				{ set: "KEY_VAULT_HOLDS" },
				"could not set KEY_VAULT_HOLDS in the azd environment",
			],
			[
				{ set: "SERVICES_RUNNING" },
				"could not set SERVICES_RUNNING in the azd environment",
			],
			[
				{ register: true },
				"could not register the resource provider Microsoft.App",
			],
			[
				{ set: "AZURE_PRINCIPAL_TYPE" },
				"could not set AZURE_PRINCIPAL_TYPE in the azd environment",
			],
		] as const) {
			const hook = run(shell, {}, { failing });
			expect({ failing, stopped: hook.exitCode !== 0 }).toEqual({
				failing,
				stopped: true,
			});
			expect(hook.stderr).toContain(`preprovision: ${said}`);
			expect(hook.sets).not.toContainEqual(
				expect.stringContaining("AZURE_PRINCIPAL_TYPE"),
			);
		}
	},
);
