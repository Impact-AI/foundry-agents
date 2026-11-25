#!/usr/bin/env bun
/**
 * A deployment, checked end to end. After `azd up`, from the repository root:
 *
 *   bun scripts/verify-deployment.ts [--env <name>] [--report <path>]
 *     [--voice] [--destructive] [--only <group>[,<group>…]] [--allow-http]
 *
 * It reads the azd environment (`azd env get-values`), asks Azure what the
 * template made (`az`, signed in as an identity that can read the resource
 * group), and drives the deployed frontend as a browser does: sign-in, a
 * typed turn, the conversations, the library and a picture, the export.
 * `--voice` opens a live session through the frontend's relay;
 * `--destructive` erases its own account and, on a private deployment, loads a
 * one-file library through `--open-listener` and checks the storage account
 * is closed again. Every check is named and answers pass, fail with what was
 * asked and what came back, or skipped with why. The run writes a Markdown and
 * a JSON report (`<path>.md`, `<path>.json`; `verify-report` unless named),
 * prints a summary, and exits 1 when anything failed.
 *
 * A default run changes nothing it does not take back: the account it signs
 * in as, and every conversation it makes, are deleted when the checks end,
 * when one throws, and on SIGINT or SIGTERM; what could not be taken back is
 * a failure in the report.
 * Under `AUTH_MODE=entra` a script cannot sign in, so the signed-in checks
 * run only with `VERIFY_SESSION_COOKIE` set to a test user's session cookie as
 * the browser holds it (`name=value`); that account is the person's and is
 * never erased. `--allow-http` admits a frontend on `localhost` over plain
 * HTTP, for a run against a stack started on this machine, and is refused for
 * any other frontend.
 *
 * Groups: `control` (Azure resources and their settings), `web` (the
 * frontend, signed out and signed in), `voice`, `telemetry` (Application
 * Insights received this run's rows) and `destructive`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const GROUPS = ["control", "web", "voice", "telemetry", "destructive"] as const;
export type Group = (typeof GROUPS)[number];

export type Status = "pass" | "fail" | "skipped";
export type Outcome = {
	group: Group;
	name: string;
	status: Status;
	detail: string;
	/** What was asked and what came back, for a failure. */
	evidence?: string;
	ms: number;
};
type Result = Omit<Outcome, "group" | "name" | "ms">;

const pass = (detail: string): Result => ({ status: "pass", detail });
const skip = (detail: string): Result => ({ status: "skipped", detail });
const fail = (detail: string, evidence?: string): Result => ({
	status: "fail",
	detail,
	...(evidence ? { evidence } : {}),
});

/** A refusal a check throws to fail with its evidence. */
class Failed extends Error {
	constructor(
		message: string,
		readonly evidence?: string,
	) {
		super(message);
	}
}
const expect = (ok: unknown, message: string, evidence?: string) => {
	if (!ok) throw new Failed(message, evidence);
};

export type Options = {
	env?: string;
	report: string;
	voice: boolean;
	destructive: boolean;
	only?: Group[];
	allowHttp: boolean;
	/** The operator accepts a run with no session under entra: the signed-in checks are not made. */
	signedOutOnly: boolean;
};

export function parseArgs(argv: string[]): Options {
	const options: Options = {
		report: "verify-report",
		voice: false,
		destructive: false,
		allowHttp: false,
		signedOutOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const next = argv[++i];
			if (!next || next.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--env") options.env = value();
		else if (arg === "--report") options.report = value();
		else if (arg === "--voice") options.voice = true;
		else if (arg === "--destructive") options.destructive = true;
		else if (arg === "--allow-http") options.allowHttp = true;
		else if (arg === "--signed-out-only") options.signedOutOnly = true;
		else if (arg === "--only") {
			const names = value().split(",");
			for (const name of names)
				if (!(GROUPS as readonly string[]).includes(name))
					throw new Error(
						`--only names no group "${name}": ${GROUPS.join(", ")}`,
					);
			options.only = names as Group[];
		} else throw new Error(`unknown argument ${arg}`);
	}
	for (const [group, flag, on] of [
		["voice", "--voice", options.voice],
		["destructive", "--destructive", options.destructive],
	] as const)
		if (options.only?.includes(group) && !on)
			throw new Error(
				`--only ${group} selects nothing without ${flag}: add ${flag}`,
			);
	if (options.signedOutOnly && (options.voice || options.destructive))
		throw new Error(
			"--signed-out-only makes no signed-in check, and --voice and --destructive are nothing else",
		);
	return options;
}

/**
 * Why a run cannot be made as asked, before anything is asked of Azure or the
 * frontend, or null. Under entra a script cannot sign in: without a session
 * the signed-in, voice, telemetry and erase checks would not be made, so the
 * run either has one (`VERIFY_SESSION_COOKIE`) or is told it is signed-out
 * only (`--signed-out-only`), never quietly both green and half checked.
 */
export function refusedRun(
	env: Record<string, string>,
	options: Options,
	selection: readonly { group: Group }[],
	cookie: string | undefined,
): string | null {
	const groups = new Set(selection.map((c) => c.group));
	// Every az call names the subscription: the groups that ask Azure need it.
	const asksAzure =
		groups.has("control") ||
		groups.has("telemetry") ||
		(groups.has("destructive") && modeOf(env).private);
	if (asksAzure && !env.AZURE_SUBSCRIPTION_ID)
		return "AZURE_SUBSCRIPTION_ID is not in the azd environment: every az call names it, so none can be made; run azd up (or azd env refresh) first";
	// A given session is a real person's, which the run never erases: under
	// the provider's sign-in the erase is not something it can check.
	if (cookie && options.destructive)
		return "--destructive erases the run's own account, and a session given in VERIFY_SESSION_COOKIE is a real person's, which is never erased: under entra the erase cannot be checked by this run. Leave out --destructive, or check the erase on a local-mode environment";
	if (modeOf(env).authMode === "entra" && !cookie && !options.signedOutOnly)
		return "AUTH_MODE is entra and VERIFY_SESSION_COOKIE is not set: without a session the signed-in, voice, telemetry and erase checks cannot be made. Set VERIFY_SESSION_COOKIE to a test user's session cookie (name=value, as the browser holds it), or pass --signed-out-only to run the signed-out checks alone";
	return null;
}

/* ---- the environment ---- */

/** Read `azd env get-values` output: one `NAME="value"` a line. */
export function parseEnvValues(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const at = line.indexOf("=");
		if (at < 1) continue;
		let value = line.slice(at + 1).trim();
		if (value.startsWith('"') && value.endsWith('"'))
			value = value.slice(1, -1).replace(/\\"/g, '"');
		values[line.slice(0, at).trim()] = value;
	}
	return values;
}

/** The deployment's shape, as the template resolves it from the same values. */
export type Mode = {
	hardened: boolean;
	private: boolean;
	zonal: boolean;
	frontDoor: boolean;
	jumpHost: boolean;
	authMode: "local" | "entra";
};

const truthy = (value: string | undefined) =>
	(value ?? "").toLowerCase() === "true";
/** An override: empty takes the bundle's answer, else `true` or not. */
const resolve = (override: string | undefined, bundle: boolean) =>
	override === undefined || override === "" ? bundle : truthy(override);

export function modeOf(env: Record<string, string>): Mode {
	const hardened = truthy(env.HARDENED);
	const isPrivate = resolve(env.PRIVATE_NETWORKING, hardened);
	return {
		hardened,
		private: isPrivate,
		zonal: resolve(env.ZONE_REDUNDANT, hardened),
		frontDoor: resolve(env.USE_FRONT_DOOR, hardened),
		jumpHost: isPrivate && truthy(env.DEVELOPER_ACCESS),
		authMode: hardened || env.AUTH_MODE === "entra" ? "entra" : "local",
	};
}

/* ---- Azure ---- */

export type Az = (args: string[]) => Promise<unknown>;

/** How long one `az` call may take before it is stopped and its check fails. */
const AZ_TIMEOUT_MS = 120_000;

/**
 * `az` with the environment's subscription and JSON out; a failure, or a call
 * past `timeoutMs`, throws with its words. A call that names its `--tenant`
 * is not given the subscription too: `az` takes one or the other.
 */
export function realAz(
	subscription: string,
	program = "az",
	timeoutMs = AZ_TIMEOUT_MS,
): Az {
	return async (args) => {
		const child = Bun.spawn(
			[
				program,
				...args,
				...(args.includes("--tenant") ? [] : ["--subscription", subscription]),
				"--only-show-errors",
				"-o",
				"json",
			],
			{ stdout: "pipe", stderr: "pipe", timeout: timeoutMs },
		);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (child.signalCode)
			throw new Failed(
				`az ${args.slice(0, 3).join(" ")} did not answer within ${timeoutMs / 1000} s`,
				`az ${args.join(" ")}`,
			);
		if (code !== 0)
			throw new Failed(
				`az ${args.slice(0, 3).join(" ")} failed`,
				`az ${args.join(" ")}\n${err.trim()}`,
			);
		return out.trim() ? JSON.parse(out) : null;
	};
}

/** The calls the control checks make, built in one place so a test asks the same. */
export const call = {
	group: (rg: string) => ["group", "show", "--name", rg],
	resources: (rg: string) => ["resource", "list", "--resource-group", rg],
	get: (id: string, apiVersion: string) => [
		"rest",
		"--method",
		"get",
		"--url",
		`${id}?api-version=${apiVersion}`,
	],
	/** A later page of a list, by the address the page before it named. */
	page: (nextLink: string) => ["rest", "--method", "get", "--url", nextLink],
	/** The template's deployments into the subscription for this azd environment. */
	deployments: (environment: string) => [
		"deployment",
		"sub",
		"list",
		"--query",
		`[?tags."azd-env-name"=='${environment}']`,
	],
	diagnostics: (id: string) => [
		"monitor",
		"diagnostic-settings",
		"list",
		"--resource",
		id,
	],
	roles: (principal: string) => [
		"role",
		"assignment",
		"list",
		"--assignee-object-id",
		principal,
		"--all",
	],
	cosmosRoles: (rg: string, account: string) => [
		"cosmosdb",
		"sql",
		"role",
		"assignment",
		"list",
		"--resource-group",
		rg,
		"--account-name",
		account,
	],
	cosmosContainer: (rg: string, account: string, container: string) => [
		"cosmosdb",
		"sql",
		"container",
		"show",
		"--resource-group",
		rg,
		"--account-name",
		account,
		"--database-name",
		"app",
		"--name",
		container,
	],
	secret: (vault: string, name: string) => [
		"keyvault",
		"secret",
		"show",
		"--vault-name",
		vault,
		"--name",
		name,
	],
	/**
	 * A token for the Application Insights query API, in the environment's
	 * tenant when it names one, else in its subscription's.
	 */
	insightsToken: (tenant: string | undefined) => [
		"account",
		"get-access-token",
		"--resource",
		INSIGHTS_API,
		...(tenant ? ["--tenant", tenant] : []),
	],
};

/** The Application Insights query API, which is also the audience of its tokens. */
export const INSIGHTS_API = "https://api.applicationinsights.io";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A query of the Application Insights application `appId` over the last
 * hour, made to its REST API with a token `az` gives for the environment's
 * tenant. `az monitor app-insights query` takes its token in the tenant of
 * the CLI's default subscription, whatever `--subscription` says, so an
 * operator whose default is in another tenant is refused (`InvalidTokenError`).
 * The answer is the API's, `{ tables: [{ columns, rows }] }`; the token is
 * never part of what a failure reports.
 */
async function queryInsights(
	az: Az,
	tenant: string | undefined,
	appId: string,
	query: string,
	send: Fetch = fetch,
	timeoutMs = AZ_TIMEOUT_MS,
): Promise<Json> {
	const token = (await az(call.insightsToken(tenant))) as {
		accessToken?: string;
	} | null;
	if (!token?.accessToken)
		throw new Failed("az gave no token for the Application Insights API");
	const url = `${INSIGHTS_API}/v1/apps/${encodeURIComponent(appId)}/query`;
	let res: Response;
	try {
		res = await send(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token.accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ query, timespan: "PT1H" }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		throw new Failed(
			"the Application Insights query got no answer",
			`POST ${url}\n${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const text = await res.text();
	if (!res.ok)
		throw new Failed(
			`the Application Insights query failed (${res.status})`,
			`POST ${url}${tenant ? ` (token for tenant ${tenant})` : ""}\n${res.status} ${text.slice(0, 500)}`,
		);
	return JSON.parse(text);
}

/** The API versions the checks read each type at. */
const API = {
	redis: "2025-07-01",
	containerApp: "2025-01-01",
	job: "2025-01-01",
	identity: "2023-01-31",
	vaultSecrets: "2023-07-01",
	storage: "2023-05-01",
	search: "2024-06-01-preview",
	waf: "2024-02-01",
	vault: "2023-07-01",
	settings: "2024-05-01",
	cognitive: "2024-10-01",
	cosmos: "2024-11-15",
};

/**
 * Each data service a private deployment closes to the public network, the
 * API version it is read at, and where its answer says so (Cosmos DB and the
 * rest name it `properties.publicNetworkAccess`; Search answers it in lower
 * case).
 */
const PUBLIC_ACCESS: readonly (readonly [string, keyof typeof API])[] = [
	["Microsoft.Cache/redisEnterprise", "redis"],
	["Microsoft.KeyVault/vaults", "vault"],
	["Microsoft.AppConfiguration/configurationStores", "settings"],
	["Microsoft.Search/searchServices", "search"],
	["Microsoft.CognitiveServices/accounts", "cognitive"],
	["Microsoft.Storage/storageAccounts", "storage"],
	["Microsoft.DocumentDB/databaseAccounts", "cosmos"],
];

/** What az answers, read by path: its shape is the service's. */
// biome-ignore lint/suspicious/noExplicitAny: an answer of az is read by path, as the service shapes it
type Json = any;

type Resource = {
	id: string;
	name: string;
	type: string;
	sku?: { name?: string } | null;
	tags?: Record<string, string> | null;
};

const PLACEHOLDER_IMAGE = "containerapps-helloworld";

/** The two container apps, by the label a check names them with and their name's prefix. */
const APPS = [
	["backend", "ca-backend-"],
	["frontend", "ca-frontend-"],
] as const;

/** A container restarted this often in its current revision is crash-looping, not settling. */
export const RESTARTS_MAX = 5;

/**
 * The Redis SKU the template makes: `redisSku` in `infra/main.parameters.json`
 * when it names one, else the parameter's default in `infra/main.bicep`. No
 * azd variable carries it, so the template's own files are what say it.
 */
function templateRedisSku(root = join(import.meta.dir, "..")): string {
	try {
		const parameters = JSON.parse(
			readFileSync(join(root, "infra", "main.parameters.json"), "utf8"),
		) as { parameters?: Record<string, { value?: unknown }> };
		const given = parameters.parameters?.redisSku?.value;
		if (typeof given === "string" && given && !given.includes("${"))
			return given;
	} catch {}
	const bicep = readFileSync(join(root, "infra", "main.bicep"), "utf8");
	const found = /^param redisSku string = '([^']+)'/m.exec(bicep)?.[1];
	if (!found) throw new Failed("infra/main.bicep names no default redisSku");
	return found;
}

/** The secrets the apps reference, each a Key Vault secret the template writes. */
export const SECRETS = [
	"auth-secret",
	"entra-client-id",
	"entra-client-secret",
	"entra-issuer",
	"impact-api-key",
] as const;

/**
 * Those whose value the sign-in needs. impact.ai's ingest key may stay the
 * placeholder: the apps read it as no key, and copy nothing.
 */
const SIGN_IN_SECRETS = SECRETS.filter((name) => name !== "impact-api-key");

/** The data roles the template gives the operator, by the names Azure lists them under. */
export const OPERATOR_ROLES = [
	"Key Vault Secrets Officer",
	"App Configuration Data Owner",
	"Storage Blob Data Contributor",
	"Search Index Data Contributor",
	"Search Service Contributor",
	"Cognitive Services OpenAI User",
] as const;
/** Foundry User, which some tenants list under an older name: matched by its id. */
const FOUNDRY_USER = "53ca6127-db72-4b80-b1b0-d745d6d5456d";

/** The private DNS zones a private deployment's data services resolve in (public cloud). */
export const PRIVATE_ZONES = [
	"privatelink.redis.azure.net",
	"privatelink.vaultcore.azure.net",
	"privatelink.azconfig.io",
	"privatelink.search.windows.net",
	"privatelink.openai.azure.com",
	"privatelink.blob.core.windows.net",
	"privatelink.services.ai.azure.com",
	"privatelink.cognitiveservices.azure.com",
	"privatelink.documents.azure.com",
];

/** The data services a private deployment reaches only through its endpoint. */
const DATA_SERVICES = [
	"Microsoft.Cache/redisEnterprise",
	"Microsoft.KeyVault/vaults",
	"Microsoft.AppConfiguration/configurationStores",
	"Microsoft.Search/searchServices",
	"Microsoft.CognitiveServices/accounts",
	"Microsoft.Storage/storageAccounts",
	"Microsoft.DocumentDB/databaseAccounts",
];

/* ---- the frontend, as a browser ---- */

/** Cookies by name, as one browser holds them. */
export class Jar {
	readonly cookies = new Map<string, string>();
	take(res: Response) {
		for (const line of res.headers.getSetCookie()) {
			const pair = line.split(";")[0] ?? "";
			const at = pair.indexOf("=");
			if (at < 1) continue;
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			if (value === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(line))
				this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}
	header() {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}
	copy() {
		const jar = new Jar();
		for (const [k, v] of this.cookies) jar.cookies.set(k, v);
		return jar;
	}
}

type Browser = {
	origin: string;
	request: (
		path: string,
		init?: RequestInit & { jar?: Jar; keepCookies?: boolean },
	) => Promise<Response>;
};

function browser(origin: string): Browser {
	return {
		origin,
		async request(path, init = {}) {
			const { jar, keepCookies, ...rest } = init;
			const headers = new Headers(rest.headers);
			if (jar?.cookies.size) headers.set("cookie", jar.header());
			const res = await fetch(`${origin}${path}`, {
				redirect: "manual",
				signal: AbortSignal.timeout(120_000),
				...rest,
				headers,
			});
			if (jar && !keepCookies) jar.take(res);
			return res;
		},
	};
}

/** A request made from outside the deployment, as a stranger would: its answer or why there was none. */
export type Probe = (url: string) => Promise<Response | Error>;

const realProbe: Probe = (url) =>
	fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(
		(err: unknown) => (err instanceof Error ? err : new Error(String(err))),
	);

const show = (method: string, path: string, res: Response, body?: string) =>
	`${method} ${path} → ${res.status}${body === undefined ? "" : `\n${body.slice(0, 600)}`}`;

const uuid = () => crypto.randomUUID();

/* ---- the run's state ---- */

export type Context = {
	env: Record<string, string>;
	mode: Mode;
	options: Options;
	az: Az;
	web: Browser;
	started: Date;
	/** The account the run signed in as, and whether the run may erase it. */
	session?: { jar: Jar; own: boolean };
	/** Accounts made by the run, erased on the way out. */
	made: Jar[];
	/** Conversations made by the run, deleted on the way out. */
	threads: Set<string>;
	/** When each typed turn the run made was sent and when its stream ended. */
	turns: { start: Date; end: Date }[];
	inventory?: Promise<Resource[]>;
	operator?: Promise<{ id: string; type: string; from: string }>;
	ingestLibrary?: string;
	/** Requests from outside, for what must answer or refuse a stranger. */
	probe: Probe;
	/** How the telemetry check reaches the Application Insights API; a test names its own. */
	insights?: Fetch;
	/** The command that runs ingest, before its arguments; a test names its own. */
	ingest?: string[];
	/** What the erased account held, for the account made after it to be checked against. */
	erased?: { threadId: string; marker: string };
	/** Every outcome so far, so a signal can report and clean up what the run reached. */
	outcomes: Outcome[];
	/** The clean-up, once begun: a signal during the checks' own clean-up waits for it. */
	cleaning?: Promise<void>;
	/** A wait between asks; a test waits for nothing. */
	pause: (ms: number) => Promise<void>;
	/** The checks the run means to make, in order. */
	planned: Check[];
	/** The check running now, so a signal can wait for it before the clean-up. */
	current?: Promise<unknown>;
	/** The signal that stopped the run, once one has: no further check starts. */
	interrupted?: string;
	/** Children running now (ingest), each told of a signal and waited for. */
	children: Set<ReturnType<typeof Bun.spawn>>;
	/** A load through --open-listener has begun: the account may be open until it is checked closed. */
	ingestBegun?: boolean;
};

/** A run against a frontend on this machine, where the backend and telemetry are this machine's too. */
const local = (ctx: Context) =>
	["localhost", "127.0.0.1"].includes(new URL(ctx.web.origin).hostname);

const need = (env: Record<string, string>, ...keys: string[]) => {
	const missing = keys.filter((k) => !env[k]);
	expect(
		missing.length === 0,
		`the azd environment has no ${missing.join(", ")}: run azd up (or azd env refresh) first`,
	);
	return keys.map((k) => env[k] as string);
};

async function inventory(ctx: Context): Promise<Resource[]> {
	ctx.inventory ??= (async () => {
		const [rg] = need(ctx.env, "AZURE_RESOURCE_GROUP");
		return (await ctx.az(call.resources(rg as string))) as Resource[];
	})();
	return ctx.inventory;
}

async function one(ctx: Context, type: string, prefix = ""): Promise<Resource> {
	const found = (await inventory(ctx)).filter(
		(r) =>
			r.type.toLowerCase() === type.toLowerCase() && r.name.startsWith(prefix),
	);
	expect(
		found.length === 1,
		`expected one ${type}${prefix ? ` named ${prefix}…` : ""} in the resource group, found ${found.length}`,
		found.map((r) => r.id).join("\n"),
	);
	return found[0] as Resource;
}

const get = async (ctx: Context, id: string, apiVersion: string) =>
	(await ctx.az(call.get(id, apiVersion))) as Record<string, Json>;

/**
 * Every item of a list Azure Resource Manager answers a page at a time, each
 * page naming the next (`nextLink`) until the last.
 */
async function getAll(
	ctx: Context,
	id: string,
	apiVersion: string,
): Promise<Json[]> {
	const items: Json[] = [];
	const seen = new Set<string>();
	let page = await get(ctx, id, apiVersion);
	for (;;) {
		items.push(...((page?.value ?? []) as Json[]));
		const next = page?.nextLink;
		if (typeof next !== "string" || !next) return items;
		expect(
			!seen.has(next),
			`the list of ${id} names a page it already gave as the next one`,
			next,
		);
		seen.add(next);
		page = (await ctx.az(call.page(next))) as Record<string, Json>;
	}
}

/**
 * The operator the template granted to, and its type: `OPERATOR_PRINCIPAL_ID`,
 * else `AZURE_PRINCIPAL_ID`, from the azd environment; an environment that
 * stores neither (azd resolves the provisioning principal at provision and
 * keeps it nowhere) is answered by the parameters of the environment's latest
 * succeeded subscription deployment, which are what the template was given.
 * Not the identity this run is signed in as: that need not be the one that
 * provisioned, and a service principal has no signed-in user to ask.
 */
async function operatorOf(
	ctx: Context,
): Promise<{ id: string; type: string; from: string }> {
	ctx.operator ??= (async () => {
		const env = ctx.env;
		if (env.OPERATOR_PRINCIPAL_ID)
			return {
				id: env.OPERATOR_PRINCIPAL_ID,
				type: env.OPERATOR_PRINCIPAL_TYPE || "User",
				from: "OPERATOR_PRINCIPAL_ID",
			};
		if (env.AZURE_PRINCIPAL_ID)
			return {
				id: env.AZURE_PRINCIPAL_ID,
				type: env.AZURE_PRINCIPAL_TYPE || "User",
				from: "AZURE_PRINCIPAL_ID",
			};
		const name = env.AZURE_ENV_NAME || ctx.options.env;
		expect(
			name,
			"neither OPERATOR_PRINCIPAL_ID nor AZURE_PRINCIPAL_ID is set, and no AZURE_ENV_NAME names the deployment to read them from",
		);
		const deployments = ((await ctx.az(call.deployments(name as string))) ??
			[]) as Json[];
		const latest = deployments
			.filter((d) => d.properties?.provisioningState === "Succeeded")
			.sort((a, b) =>
				String(b.properties?.timestamp).localeCompare(
					String(a.properties?.timestamp),
				),
			)[0];
		const p = latest?.properties?.parameters ?? {};
		const named = p.operatorPrincipalId?.value;
		const id = named || p.principalId?.value;
		expect(
			typeof id === "string" && id,
			`neither OPERATOR_PRINCIPAL_ID nor AZURE_PRINCIPAL_ID is set, and no succeeded deployment of ${name} names a principal`,
			deployments.map((d) => d.name).join("\n") || "(no deployment)",
		);
		return {
			id: id as string,
			type:
				(named ? p.operatorPrincipalType?.value : p.principalType?.value) ||
				"User",
			from: `the deployment ${latest.name}`,
		};
	})();
	return ctx.operator;
}

/** A container app by its name's prefix, and what az says of it. */
async function appOf(ctx: Context, prefix: string) {
	const app = await one(ctx, "Microsoft.App/containerApps", prefix);
	const p: Json = (await get(ctx, app.id, API.containerApp)).properties ?? {};
	return { app, p };
}

/* ---- the checks ---- */

type Check = {
	group: Group;
	name: string;
	run: (ctx: Context) => Promise<Result>;
};

/**
 * The run's session, for a signed-in check. Without one the check is not
 * made: a skip only when the operator asked for a signed-out run, a failure
 * otherwise, since a deployment whose sign-in is broken must not pass.
 */
const signedIn = (ctx: Context) => {
	if (ctx.options.signedOutOnly)
		throw new Skip(
			"--signed-out-only: the operator chose a run with no session",
		);
	if (!ctx.session)
		throw new Failed(
			"not checked: no session (the sign-in check did not pass)",
		);
	return ctx.session.jar;
};
class Skip extends Error {}

const CONTROL: Check[] = [
	{
		group: "control",
		name: "resource group exists",
		async run(ctx) {
			const [rg] = need(ctx.env, "AZURE_RESOURCE_GROUP");
			const group = (await ctx.az(call.group(rg as string))) as {
				properties?: { provisioningState?: string };
			};
			expect(
				group?.properties?.provisioningState === "Succeeded",
				`the resource group is ${group?.properties?.provisioningState}`,
			);
			return pass(`${rg} is provisioned`);
		},
	},
	{
		group: "control",
		name: "every resource the mode needs is there",
		async run(ctx) {
			const types = new Set(
				(await inventory(ctx)).map((r) => r.type.toLowerCase()),
			);
			const wanted = [
				"Microsoft.App/containerApps",
				"Microsoft.App/jobs",
				"Microsoft.App/managedEnvironments",
				"Microsoft.ContainerRegistry/registries",
				"Microsoft.ManagedIdentity/userAssignedIdentities",
				"Microsoft.OperationalInsights/workspaces",
				"Microsoft.Insights/components",
				...DATA_SERVICES,
				...(ctx.mode.private
					? [
							"Microsoft.Network/virtualNetworks",
							"Microsoft.Network/privateEndpoints",
							"Microsoft.Network/privateDnsZones",
						]
					: []),
				...(ctx.mode.frontDoor
					? [
							"Microsoft.Cdn/profiles",
							"Microsoft.Network/frontdoorWebApplicationFirewallPolicies",
						]
					: []),
				...(ctx.mode.jumpHost
					? [
							"Microsoft.Compute/virtualMachines",
							"Microsoft.Network/bastionHosts",
						]
					: []),
			];
			const missing = wanted.filter((t) => !types.has(t.toLowerCase()));
			expect(
				missing.length === 0,
				`missing: ${missing.join(", ")}`,
				[...types].sort().join("\n"),
			);
			const old = types.has("microsoft.cache/redis")
				? " An Azure Cache for Redis from an earlier template is still in the group; nothing reads it, and it is the operator's to delete."
				: "";
			return pass(`${wanted.length} resource types present.${old}`);
		},
	},
	{
		group: "control",
		name: "Azure Managed Redis instance",
		async run(ctx) {
			const redis = await one(ctx, "Microsoft.Cache/redisEnterprise");
			const r = await get(ctx, redis.id, API.redis);
			const sku = templateRedisSku();
			const ha = ctx.mode.zonal ? "Enabled" : "Disabled";
			const access = ctx.mode.private ? "Disabled" : "Enabled";
			const seen = {
				sku: r.sku?.name,
				highAvailability: r.properties?.highAvailability,
				publicNetworkAccess: r.properties?.publicNetworkAccess,
				minimumTlsVersion: r.properties?.minimumTlsVersion,
			};
			expect(
				seen.sku === sku &&
					seen.highAvailability === ha &&
					seen.publicNetworkAccess === access &&
					seen.minimumTlsVersion === "1.2",
				`expected ${sku}, high availability ${ha}, public access ${access}, TLS 1.2`,
				JSON.stringify(seen),
			);
			return pass(`${sku}, high availability ${ha}, public access ${access}`);
		},
	},
	{
		group: "control",
		name: "Azure Managed Redis database",
		async run(ctx) {
			const redis = await one(ctx, "Microsoft.Cache/redisEnterprise");
			const d = await get(ctx, `${redis.id}/databases/default`, API.redis);
			const p = d.properties ?? {};
			const seen = {
				clusteringPolicy: p.clusteringPolicy,
				port: p.port,
				accessKeysAuthentication: p.accessKeysAuthentication,
				clientProtocol: p.clientProtocol,
			};
			expect(
				seen.clusteringPolicy === "NoCluster" &&
					seen.port === 10000 &&
					seen.accessKeysAuthentication === "Disabled" &&
					seen.clientProtocol === "Encrypted",
				"expected NoCluster on port 10000, TLS, access keys disabled",
				JSON.stringify(seen),
			);
			expect(
				!ctx.env.REDIS_PORT || ctx.env.REDIS_PORT === "10000",
				`REDIS_PORT in the environment is ${ctx.env.REDIS_PORT}, not the database's 10000`,
			);
			return pass("NoCluster, port 10000, TLS, access keys disabled");
		},
	},
	{
		group: "control",
		name: "Redis admits the backend and the operator, no group",
		async run(ctx) {
			const redis = await one(ctx, "Microsoft.Cache/redisEnterprise");
			const identity = await one(
				ctx,
				"Microsoft.ManagedIdentity/userAssignedIdentities",
				"id-backend-",
			);
			const backend = (await get(ctx, identity.id, API.identity)).properties
				?.principalId;
			expect(
				typeof backend === "string" && backend,
				"the backend's identity names no principal: nothing can be matched against the policy",
			);
			const list = await get(
				ctx,
				`${redis.id}/databases/default/accessPolicyAssignments`,
				API.redis,
			);
			const objectIds = ((list.value ?? []) as Json[]).map(
				(a) => a.properties?.user?.objectId,
			);
			expect(
				objectIds.every((id) => typeof id === "string" && id),
				"an assignment on the policy names no principal",
				JSON.stringify(list.value ?? []),
			);
			const admitted = new Set<string>(objectIds as string[]);
			const wanted = new Set([backend]);
			let operatorType = "";
			if (ctx.mode.jumpHost) {
				const operator = await operatorOf(ctx);
				operatorType = operator.type;
				if (operatorType !== "Group") wanted.add(operator.id);
			}
			const same =
				admitted.size === wanted.size &&
				[...wanted].every((id) => admitted.has(id));
			expect(
				same,
				`expected exactly ${[...wanted].join(", ")}${operatorType === "Group" ? " (a group operator is never admitted: the service takes no groups)" : ""}`,
				[...admitted].join("\n") || "(none)",
			);
			return pass(`${admitted.size} assignment(s) on the default policy`);
		},
	},
	{
		group: "control",
		name: "both apps run a built image with probes",
		async run(ctx) {
			const notes: string[] = [];
			for (const [label, prefix] of APPS) {
				const { p } = await appOf(ctx, prefix);
				const container = p.template?.containers?.[0] ?? {};
				expect(
					typeof container.image === "string" &&
						!container.image.includes(PLACEHOLDER_IMAGE),
					`the ${label} runs the placeholder image: azd deploy has not run, or a provision put it back`,
					String(container.image),
				);
				// The image azd last deployed, when this environment names it: an older one left by a failed deploy is not it.
				const deployed = ctx.env[`SERVICE_${label.toUpperCase()}_IMAGE_NAME`];
				expect(
					!deployed || container.image === deployed,
					`the ${label} runs ${container.image}, not ${deployed}, the image azd last deployed`,
				);
				expect(
					Array.isArray(container.probes) && container.probes.length > 0,
					`the ${label} has no probes`,
				);
				notes.push(`${label} ${container.image}`);
			}
			const job = await one(ctx, "Microsoft.App/jobs", "caj-migrate-");
			const j = await get(ctx, job.id, API.job);
			const jobImage = j.properties?.template?.containers?.[0]?.image;
			expect(
				typeof jobImage === "string" && !jobImage.includes(PLACEHOLDER_IMAGE),
				"the migrate job runs the placeholder image",
				String(jobImage),
			);
			const backendImage = ctx.env.SERVICE_BACKEND_IMAGE_NAME;
			expect(
				!backendImage || jobImage === backendImage,
				`the migrate job runs ${jobImage}, not the backend's ${backendImage}`,
			);
			return pass(notes.join("; "));
		},
	},
	{
		group: "control",
		name: "both apps' latest revision is healthy and running",
		async run(ctx) {
			const notes: string[] = [];
			for (const [label, prefix] of APPS) {
				const { app, p } = await appOf(ctx, prefix);
				const latest = p.latestRevisionName;
				expect(
					typeof latest === "string" && latest,
					`the ${label} names no latest revision`,
				);
				expect(
					p.latestReadyRevisionName === latest,
					`the ${label}'s latest revision ${latest} never became ready; ${p.latestReadyRevisionName ?? "none"} is the last that did`,
				);
				const revision = `${app.id}/revisions/${latest}`;
				const r = (await get(ctx, revision, API.containerApp)).properties ?? {};
				expect(
					r.healthState === "Healthy" &&
						["Running", "RunningAtMaxScale"].includes(r.runningState),
					`the ${label}'s revision is ${r.healthState}, ${r.runningState}`,
					JSON.stringify({
						healthState: r.healthState,
						runningState: r.runningState,
						runningStateDetails: r.runningStateDetails,
					}),
				);
				const replicas = ((
					await get(ctx, `${revision}/replicas`, API.containerApp)
				).value ?? []) as Json[];
				const containers = replicas.flatMap(
					(replica) => (replica.properties?.containers ?? []) as Json[],
				);
				const down = replicas.filter(
					(replica) => replica.properties?.runningState !== "Running",
				);
				const unready = containers.filter((c) => c.ready !== true);
				const restarts = Math.max(
					0,
					...containers.map((c) => Number(c.restartCount ?? 0)),
				);
				expect(
					replicas.length > 0 &&
						down.length === 0 &&
						unready.length === 0 &&
						restarts < RESTARTS_MAX,
					replicas.length === 0
						? `the ${label} runs no replica`
						: `the ${label} is not running cleanly: ${down.length} replica(s) not running, ${unready.length} container(s) not ready, up to ${restarts} restart(s)`,
					JSON.stringify(
						replicas.map((replica) => ({
							name: replica.name,
							runningState: replica.properties?.runningState,
							containers: (replica.properties?.containers ?? []).map(
								(c: Json) => ({ ready: c.ready, restartCount: c.restartCount }),
							),
						})),
					),
				);
				notes.push(`${label} ${latest}: ${replicas.length} replica(s) ready`);
			}
			return pass(notes.join("; "));
		},
	},
	{
		group: "control",
		name: "replica floors",
		async run(ctx) {
			const floor = ctx.mode.zonal ? 2 : 1;
			const seen: string[] = [];
			for (const [label, prefix, key] of [
				["backend", "ca-backend-", "BACKEND_MIN_REPLICAS"],
				["frontend", "ca-frontend-", "FRONTEND_MIN_REPLICAS"],
			] as const) {
				const app = await one(ctx, "Microsoft.App/containerApps", prefix);
				const a = await get(ctx, app.id, API.containerApp);
				const min = Number(a.properties?.template?.scale?.minReplicas ?? 0);
				const wanted = Math.max(floor, Number(ctx.env[key] || 1));
				expect(
					min >= wanted,
					`the ${label} keeps ${min} replica(s) at rest, below ${wanted}`,
				);
				seen.push(`${label} ${min}`);
			}
			const search = await one(ctx, "Microsoft.Search/searchServices");
			const s = await get(ctx, search.id, API.search);
			const replicas = Number(s.properties?.replicaCount ?? 0);
			const wanted = Math.max(floor, Number(ctx.env.SEARCH_REPLICAS || 1));
			expect(
				replicas >= wanted,
				`AI Search runs ${replicas} replica(s), below ${wanted}`,
			);
			seen.push(`search ${replicas}`);
			return pass(seen.join(", "));
		},
	},
	{
		group: "control",
		name: "Key Vault holds every secret the apps reference",
		async run(ctx) {
			const vault = await one(ctx, "Microsoft.KeyVault/vaults");
			const list = await getAll(ctx, `${vault.id}/secrets`, API.vaultSecrets);
			const held = new Set(list.map((s) => s.name));
			const missing = SECRETS.filter((s) => !held.has(s));
			expect(
				missing.length === 0,
				`the vault holds no ${missing.join(", ")}`,
				[...held].join("\n"),
			);
			if (ctx.mode.private)
				return pass(
					"all five held. Their VALUES WERE NOT READ: the vault is closed to the network this run asks from. The session secret's value is held by the backend, which refuses to start on the placeholder (the revision check shows it started); the Entra client id by the sign-in redirect check; the Entra client secret by the frontend, which refuses to start on the placeholder (the revision check shows it started). A wrong secret that is not the placeholder shows only when someone signs in",
				);
			const placeholders: string[] = [];
			const values =
				ctx.mode.authMode === "entra" ? SIGN_IN_SECRETS : ["auth-secret"];
			for (const name of values) {
				const secret = (await ctx.az(call.secret(vault.name, name))) as {
					value?: string;
				};
				if (!secret?.value || secret.value === "unset") placeholders.push(name);
				else if (name === "auth-secret" && secret.value.length < 32)
					placeholders.push(`${name} (shorter than 32 characters)`);
			}
			expect(
				placeholders.length === 0,
				`placeholder values: ${placeholders.join(", ")}`,
			);
			return pass(
				`all five held; ${values.join(", ")} carry real values (not printed)`,
			);
		},
	},
	{
		group: "control",
		name: "the accounts container keeps per-document lifetimes",
		async run(ctx) {
			const [rg] = need(ctx.env, "AZURE_RESOURCE_GROUP");
			const cosmos = await one(ctx, "Microsoft.DocumentDB/databaseAccounts");
			const c = (await ctx.az(
				call.cosmosContainer(rg as string, cosmos.name, "accounts"),
			)) as { resource?: { defaultTtl?: number } };
			expect(
				c?.resource?.defaultTtl === -1,
				`defaultTtl is ${c?.resource?.defaultTtl}, not -1: an erase marker would never expire, and the backend refuses to start`,
			);
			return pass("defaultTtl -1");
		},
	},
	{
		group: "control",
		name: "the storage account is closed and carries no ingest tag",
		async run(ctx) {
			const storage = await one(ctx, "Microsoft.Storage/storageAccounts");
			const s = await get(ctx, storage.id, API.storage);
			const tag = s.tags?.ingestListener;
			expect(
				!tag,
				"an ingest run left its tag: the account may still be open to its address; run scripts/ingest.sh --close-leftover",
				String(tag),
			);
			if (!ctx.mode.private)
				return pass("no ingest tag (demo: the account is public by design)");
			const p = s.properties ?? {};
			const seen = {
				publicNetworkAccess: p.publicNetworkAccess,
				defaultAction: p.networkAcls?.defaultAction,
				ipRules: (p.networkAcls?.ipRules ?? []).map((r: Json) => r.value),
			};
			expect(
				seen.publicNetworkAccess === "Disabled" &&
					seen.defaultAction === "Deny" &&
					seen.ipRules.length === 0,
				"expected public access Disabled, default Deny, no IP rule",
				JSON.stringify(seen),
			);
			return pass("public access Disabled, default Deny, no IP rule, no tag");
		},
	},
	{
		group: "control",
		name: "no data service answers the public network",
		async run(ctx) {
			if (!ctx.mode.private)
				return skip("not private: the data services are public by design");
			const open: string[] = [];
			for (const [type, version] of PUBLIC_ACCESS) {
				const service = await one(ctx, type);
				const access = (await get(ctx, service.id, API[version])).properties
					?.publicNetworkAccess;
				// An answer that does not say is not an answer that it is closed.
				if (String(access).toLowerCase() !== "disabled")
					open.push(`${type} (${access ?? "not said"})`);
			}
			expect(
				open.length === 0,
				`open to the public network on a private deployment: ${open.join(", ")}`,
			);
			return pass(
				`${PUBLIC_ACCESS.length} data services have public network access Disabled`,
			);
		},
	},
	{
		group: "control",
		name: "private endpoints and their DNS zones",
		async run(ctx) {
			if (!ctx.mode.private)
				return skip("not private: the data services have no private endpoints");
			const all = await inventory(ctx);
			const endpoints = all.filter(
				(r) => r.type.toLowerCase() === "microsoft.network/privateendpoints",
			);
			const linked = new Map<string, string>();
			for (const e of endpoints) {
				const p = (await get(ctx, e.id, "2024-05-01")).properties ?? {};
				for (const c of p.privateLinkServiceConnections ?? [])
					linked.set(
						String(c.properties?.privateLinkServiceId).toLowerCase(),
						c.properties?.privateLinkServiceConnectionState?.status,
					);
			}
			const unlinked: string[] = [];
			for (const type of DATA_SERVICES) {
				const service = all.find(
					(r) => r.type.toLowerCase() === type.toLowerCase(),
				);
				const state = service && linked.get(service.id.toLowerCase());
				if (state !== "Approved") unlinked.push(`${type} (${state ?? "none"})`);
			}
			const zones = new Set(
				all
					.filter(
						(r) => r.type.toLowerCase() === "microsoft.network/privatednszones",
					)
					.map((r) => r.name),
			);
			const noZone = PRIVATE_ZONES.filter((z) => !zones.has(z));
			expect(
				unlinked.length === 0 && noZone.length === 0,
				[
					unlinked.length ? `no approved endpoint: ${unlinked.join(", ")}` : "",
					noZone.length ? `no zone: ${noZone.join(", ")}` : "",
				]
					.filter(Boolean)
					.join("; "),
			);
			return pass(
				`${DATA_SERVICES.length} services behind approved endpoints; ${PRIVATE_ZONES.length} zones`,
			);
		},
	},
	{
		group: "control",
		name: "diagnostic settings send to the workspace",
		async run(ctx) {
			const redis = await one(ctx, "Microsoft.Cache/redisEnterprise");
			const workspace = (
				await one(ctx, "Microsoft.OperationalInsights/workspaces")
			).id.toLowerCase();
			const targets: [string, string][] = [
				["Redis instance", redis.id],
				["Redis database", `${redis.id}/databases/default`],
			];
			for (const type of [
				"Microsoft.KeyVault/vaults",
				"Microsoft.AppConfiguration/configurationStores",
				"Microsoft.Search/searchServices",
				"Microsoft.CognitiveServices/accounts",
				"Microsoft.DocumentDB/databaseAccounts",
				"Microsoft.Storage/storageAccounts",
				"Microsoft.ContainerRegistry/registries",
			]) {
				const r = await one(ctx, type);
				targets.push([type, r.id]);
			}
			const without: string[] = [];
			for (const [label, id] of targets) {
				const list = (await ctx.az(call.diagnostics(id))) as Json;
				const settings = (
					Array.isArray(list) ? list : (list?.value ?? [])
				) as Json[];
				const sent = settings.map((s) =>
					String(
						s.workspaceId ?? s.properties?.workspaceId ?? "",
					).toLowerCase(),
				);
				if (!sent.includes(workspace)) without.push(label);
			}
			expect(
				without.length === 0,
				`no diagnostic setting to this environment's workspace on: ${without.join(", ")}`,
			);
			return pass(`${targets.length} resources diagnosed`);
		},
	},
	{
		group: "control",
		name: "the operator holds the data roles",
		async run(ctx) {
			const [rg] = need(ctx.env, "AZURE_RESOURCE_GROUP");
			const { id: operator, from } = await operatorOf(ctx);
			const [subscription] = need(ctx.env, "AZURE_SUBSCRIPTION_ID");
			// The group itself or a resource in it: a group whose name only begins as this one's is another.
			const scope =
				`/subscriptions/${subscription}/resourcegroups/${rg}`.toLowerCase();
			const roles = (
				(await ctx.az(call.roles(operator as string))) as Json[]
			).filter((a) => {
				const at = String(a.scope).toLowerCase();
				return at === scope || at.startsWith(`${scope}/`);
			});
			const names = new Set(roles.map((a) => a.roleDefinitionName as string));
			const missing: string[] = OPERATOR_ROLES.filter((r) => !names.has(r));
			if (
				!roles.some((a) =>
					String(a.roleDefinitionId).toLowerCase().endsWith(FOUNDRY_USER),
				)
			)
				missing.push("Foundry User");
			const cosmos = await one(ctx, "Microsoft.DocumentDB/databaseAccounts");
			const cosmosRoles = (await ctx.az(
				call.cosmosRoles(rg as string, cosmos.name),
			)) as Json[];
			if (!cosmosRoles.some((a) => a.principalId === operator))
				missing.push("a Cosmos DB data role");
			expect(
				missing.length === 0,
				`the operator ${operator} lacks: ${missing.join(", ")}`,
				[...names].sort().join("\n"),
			);
			const earlier =
				ctx.env.OPERATOR_PRINCIPAL_ID &&
				ctx.env.OPERATOR_PRINCIPAL_ID !== ctx.env.AZURE_PRINCIPAL_ID
					? " A principal that provisioned before the operator was named keeps what it was given until removed by hand."
					: "";
			return pass(
				`${OPERATOR_ROLES.length + 2} data roles held by ${operator} (from ${from}).${earlier}`,
			);
		},
	},
	{
		group: "control",
		name: "the edge's WAF blocks",
		async run(ctx) {
			if (!ctx.mode.frontDoor) return skip("no Front Door in this mode");
			const waf = await one(
				ctx,
				"Microsoft.Network/frontdoorWebApplicationFirewallPolicies",
			);
			const w = await get(ctx, waf.id, API.waf);
			const p = w.properties?.policySettings ?? {};
			expect(
				p.enabledState === "Enabled" && p.mode === "Prevention",
				"expected the policy Enabled in Prevention",
				JSON.stringify(p),
			);
			return pass("Enabled, Prevention");
		},
	},
	{
		group: "control",
		name: "the frontend is reached through the edge and only there",
		async run(ctx) {
			if (!ctx.mode.frontDoor) return skip("no Front Door in this mode");
			const [url, edge] = need(ctx.env, "FRONTEND_URL", "FRONT_DOOR_ENDPOINT");
			const host = new URL(url as string).host;
			expect(
				ctx.env.PUBLIC_ORIGIN || host === edge,
				`FRONTEND_URL is ${host}, not the Front Door endpoint ${edge}`,
			);
			const through = await ctx.probe(`https://${edge}/health`);
			expect(
				!(through instanceof Error) && through.status === 200,
				"the Front Door endpoint does not answer /health",
				through instanceof Error
					? `GET https://${edge}/health → ${through.message}`
					: `GET https://${edge}/health → ${through.status}`,
			);
			const app = await one(ctx, "Microsoft.App/containerApps", "ca-frontend-");
			const fqdn = (await get(ctx, app.id, API.containerApp)).properties
				?.configuration?.ingress?.fqdn;
			expect(
				typeof fqdn === "string" && fqdn,
				"the frontend app names no ingress host",
			);
			const around = await ctx.probe(`https://${fqdn}/health`);
			expect(
				around instanceof Error || around.status >= 400,
				"the frontend answers on its own host from outside, around the edge and its WAF",
				`GET https://${fqdn}/health → ${around instanceof Error ? around.message : around.status}`,
			);
			return pass(
				`${edge} answers; ${fqdn} refuses from outside (${around instanceof Error ? around.name : around.status})${ctx.env.PUBLIC_ORIGIN ? `; FRONTEND_URL is the custom origin ${host}` : ""}`,
			);
		},
	},
];

/** Every directive of a policy header, by name. */
export function directives(policy: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const part of policy.split(";")) {
		const [name, ...values] = part.trim().split(/\s+/);
		if (name) map.set(name.toLowerCase(), values);
	}
	return map;
}

async function signInLocally(ctx: Context): Promise<Jar> {
	// Once the run is stopping, an account made now would be made after its clean-up looked.
	expect(!ctx.interrupted && !ctx.cleaning, "not made: the run is stopping");
	const jar = new Jar();
	const csrf = await ctx.web.request("/api/auth/csrf", { jar });
	const body = (await csrf.json().catch(() => ({}))) as { csrfToken?: string };
	expect(
		csrf.status === 200 && body.csrfToken,
		"no CSRF token",
		show("GET", "/api/auth/csrf", csrf),
	);
	ctx.made.push(jar);
	const form = new URLSearchParams({
		csrfToken: body.csrfToken as string,
		name: "Verify deployment",
		callbackUrl: `${ctx.web.origin}/chat`,
	});
	const signIn = await ctx.web.request("/api/auth/callback/local", {
		method: "POST",
		jar,
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form,
	});
	await signIn.arrayBuffer();
	const me = await ctx.web.request("/api/conversations", { jar });
	const text = await me.text();
	expect(
		me.status === 200,
		"signed in, the conversations did not answer",
		show("GET", "/api/conversations", me, text),
	);
	return jar;
}

async function runTurn(ctx: Context, jar: Jar, threadId: string, text: string) {
	const runId = uuid();
	const start = new Date();
	const res = await ctx.web.request("/api/copilotkit", {
		method: "POST",
		jar,
		headers: {
			"content-type": "application/json",
			accept: "text/event-stream",
		},
		body: JSON.stringify({
			method: "agent/run",
			params: { agentId: "assistant" },
			body: {
				threadId,
				runId,
				tools: [],
				context: [],
				forwardedProps: {},
				state: {},
				messages: [{ id: uuid(), role: "user", content: text }],
			},
		}),
	});
	const stream = await res.text();
	return { res, stream, start, end: new Date() };
}

/** The directives the app's policy sets beside `script-src`, each with the one value it must hold. */
const POLICY_DIRECTIVES: readonly (readonly [string, string])[] = [
	["default-src", "'self'"],
	["object-src", "'none'"],
	["base-uri", "'self'"],
	["form-action", "'self'"],
	["frame-ancestors", "'none'"],
	["frame-src", "'none'"],
];

/** What is wrong with a page's policy and headers, or nothing. */
function pageProblems(res: Response, html: string, https: boolean): string[] {
	const problems: string[] = [];
	const policy = res.headers.get("content-security-policy") ?? "";
	const parsed = directives(policy);
	const script = parsed.get("script-src") ?? [];
	const nonce = script.find((v) => v.startsWith("'nonce-"));
	if (res.status !== 200) problems.push(`answered ${res.status}`);
	if (!nonce || !script.includes("'strict-dynamic'"))
		problems.push("script-src has no nonce with 'strict-dynamic'");
	if (script.includes("'unsafe-inline'") || script.includes("'unsafe-eval'"))
		problems.push("script-src admits 'unsafe-inline' or 'unsafe-eval'");
	for (const [name, value] of POLICY_DIRECTIVES)
		if (!parsed.get(name)?.includes(value))
			problems.push(`${name} is not ${value}`);
	if (nonce && !html.includes(`nonce="${nonce.slice(7, -1)}"`))
		problems.push("the page's scripts do not carry the header's nonce");
	for (const [header, value] of [
		["x-content-type-options", "nosniff"],
		["x-frame-options", "DENY"],
		["referrer-policy", "strict-origin-when-cross-origin"],
	] as const)
		if (res.headers.get(header) !== value)
			problems.push(`${header} is not ${value}`);
	if (https && !res.headers.get("strict-transport-security"))
		problems.push("no Strict-Transport-Security");
	return problems;
}

/** Each page loaded twice: its policy whole each time, and a nonce of its own each time. */
async function policedPages(
	ctx: Context,
	paths: string[],
	jar?: Jar,
): Promise<string> {
	const https = ctx.web.origin.startsWith("https:");
	for (const path of paths) {
		const nonces: string[] = [];
		for (let i = 0; i < 2; i++) {
			const res = await ctx.web.request(path, { jar });
			const html = await res.text();
			const policy = res.headers.get("content-security-policy") ?? "";
			const problems = pageProblems(res, html, https);
			expect(
				problems.length === 0,
				`${path}: ${problems.join("; ")}`,
				show("GET", path, res, policy),
			);
			nonces.push(
				(directives(policy).get("script-src") ?? []).find((v) =>
					v.startsWith("'nonce-"),
				) as string,
			);
		}
		expect(
			nonces[0] !== nonces[1],
			`${path}: two loads were given the same nonce`,
		);
	}
	return paths.join(", ");
}

/** A response's cookies by name only: their values are a session. */
const cookieNames = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((line) => line.split("=")[0]?.trim())
		.join(", ");

const WEB: Check[] = [
	{
		group: "web",
		name: "the frontend answers /health",
		async run(ctx) {
			const res = await ctx.web.request("/health");
			expect(
				res.status === 200,
				"not 200",
				show("GET", "/health", res, await res.text()),
			);
			return pass("200");
		},
	},
	{
		group: "web",
		name: "pages carry a nonce policy and the security headers",
		async run(ctx) {
			const seen = await policedPages(ctx, ["/login", "/privacy"]);
			return pass(
				`${seen}: a fresh nonce per load, 'strict-dynamic', no unsafe-inline or unsafe-eval, and every directive and header the app sets`,
			);
		},
	},
	{
		group: "web",
		name: "a public file sets no cookie",
		async run(ctx) {
			const res = await ctx.web.request("/voice/capture-worklet.js");
			await res.arrayBuffer();
			expect(
				res.status === 200,
				"the worklet is not served",
				show("GET", "/voice/capture-worklet.js", res),
			);
			expect(
				res.headers.getSetCookie().length === 0,
				"a static file set a cookie",
				`Set-Cookie names: ${cookieNames(res)}`,
			);
			// The deployment's logo is public and kept by shared caches, so it
			// sets no cookie either; a deployment that names none answers 404.
			const logo = await ctx.web.request("/api/appearance/logo");
			await logo.arrayBuffer();
			expect(
				logo.status === 200 || logo.status === 404,
				"the logo is neither served nor absent",
				show("GET", "/api/appearance/logo", logo),
			);
			expect(
				logo.headers.getSetCookie().length === 0,
				"the public logo set a cookie",
				`Set-Cookie names: ${cookieNames(logo)}`,
			);
			return pass(
				`200, no Set-Cookie; the logo ${logo.status === 200 ? "200" : "404, none configured"}, no Set-Cookie`,
			);
		},
	},
	{
		group: "web",
		name: "the API refuses a caller with no session",
		async run(ctx) {
			for (const path of ["/api/conversations", "/api/nope"]) {
				const res = await ctx.web.request(path);
				const text = await res.text();
				expect(
					res.status === 401,
					`${path} is not 401`,
					show("GET", path, res, text),
				);
			}
			return pass("401 for a real and an unknown API path");
		},
	},
	{
		group: "web",
		name: "the backend is not reachable from outside",
		async run(ctx) {
			if (local(ctx))
				return skip("a local run: the backend is on this machine");
			const [backend] = need(ctx.env, "BACKEND_URL");
			const res = await ctx.probe(`${backend}/health`);
			if (res instanceof Error)
				return pass(`no answer from outside (${res.message})`);
			const body = await res.text().catch(() => "");
			// An internal app's name resolves only inside its environment, so a
			// stranger normally gets no connection at all; reached through the
			// environment's public ingress, the platform answers 404 with its own
			// page naming no app. Both are known from the service's behaviour.
			expect(
				res.status === 404 && /container app/i.test(body),
				"something answered for the backend from outside its environment",
				`GET ${backend}/health → ${res.status}\n${body.slice(0, 300)}`,
			);
			return pass(
				"the platform's own 404 for an app it does not serve outside",
			);
		},
	},
	{
		group: "web",
		name: "sign-in goes to Entra with a real client id",
		async run(ctx) {
			if (ctx.mode.authMode !== "entra")
				return skip("AUTH_MODE is local: no identity provider to go to");
			const jar = new Jar();
			const csrf = await ctx.web.request("/api/auth/csrf", { jar });
			const { csrfToken } = (await csrf.json().catch(() => ({}))) as {
				csrfToken?: string;
			};
			expect(csrfToken, "no CSRF token", `GET /api/auth/csrf → ${csrf.status}`);
			const start = await ctx.web.request(
				"/api/auth/signin/microsoft-entra-id",
				{
					method: "POST",
					jar,
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						csrfToken: csrfToken as string,
						callbackUrl: `${ctx.web.origin}/chat`,
					}),
				},
			);
			await start.arrayBuffer();
			const location = start.headers.get("location") ?? "";
			let to: URL | null = null;
			try {
				to = new URL(location);
			} catch {}
			const client = to?.searchParams.get("client_id") ?? "";
			const guid =
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			// The redirect's address only: its query carries a state and a challenge of the browser's.
			const where = to ? `${to.origin}${to.pathname}` : "(no address)";
			expect(
				start.status === 302 && to?.hostname === "login.microsoftonline.com",
				"the sign-in does not go to Entra: its client id, secret or issuer is the placeholder, or the provider is not set up",
				`POST /api/auth/signin/microsoft-entra-id → ${start.status} ${where}`,
			);
			expect(
				guid.test(client),
				`the client id the sign-in names is not a client id: "${client}"`,
			);
			const wanted = ctx.env.AUTH_MICROSOFT_ENTRA_ID_ID;
			expect(
				!wanted || client.toLowerCase() === wanted.toLowerCase(),
				`the sign-in names client ${client}, not this environment's ${wanted}`,
			);
			const tenant = ctx.env.AZURE_TENANT_ID;
			expect(
				!tenant ||
					to?.pathname.split("/")[1]?.toLowerCase() === tenant.toLowerCase(),
				`the sign-in goes to tenant ${to?.pathname.split("/")[1]}, not this environment's ${tenant}`,
				where,
			);
			return pass(`302 to ${where} with client ${client}`);
		},
	},
	{
		group: "web",
		name: "sign-in holds a session",
		async run(ctx) {
			const given = process.env.VERIFY_SESSION_COOKIE;
			if (given) {
				const jar = new Jar();
				const at = given.indexOf("=");
				expect(at > 0, "VERIFY_SESSION_COOKIE is not name=value");
				jar.cookies.set(given.slice(0, at), given.slice(at + 1));
				const me = await ctx.web.request("/api/conversations", { jar });
				expect(
					me.status === 200,
					"the given session is refused",
					show("GET", "/api/conversations", me, await me.text()),
				);
				ctx.session = { jar, own: false };
				return pass("the given session is accepted");
			}
			if (ctx.options.signedOutOnly)
				return skip(
					"--signed-out-only: the operator chose a run with no session",
				);
			expect(
				ctx.mode.authMode === "local",
				"not checked: AUTH_MODE is entra and no VERIFY_SESSION_COOKIE was given",
			);
			ctx.session = { jar: await signInLocally(ctx), own: true };
			return pass("a local sign-in, then the conversations answer 200");
		},
	},
	{
		group: "web",
		name: "signed-in pages carry the same policy",
		async run(ctx) {
			const jar = signedIn(ctx);
			const seen = await policedPages(ctx, ["/chat", "/settings"], jar);
			return pass(`${seen}: the nonce policy and headers, signed in`);
		},
	},
	{
		group: "web",
		name: "an unknown API path answers as an API does",
		async run(ctx) {
			const jar = signedIn(ctx);
			const res = await ctx.web.request("/api/nope", { jar });
			const body = await res.text();
			expect(
				res.status === 404 && body.includes('"not_found"'),
				"not a JSON 404",
				show("GET", "/api/nope", res, body),
			);
			const file = await ctx.web.request("/voice/capture-worklet.js", {
				jar,
				keepCookies: true,
			});
			await file.arrayBuffer();
			expect(
				file.headers.getSetCookie().length === 0,
				"a static file set a cookie for a signed-in browser",
				`Set-Cookie names: ${cookieNames(file)}`,
			);
			return pass(
				"404 {code: not_found}; a static file sets no cookie signed in either",
			);
		},
	},
	{
		group: "web",
		name: "a write from another origin is refused",
		async run(ctx) {
			const jar = signedIn(ctx);
			const foreign = await ctx.web.request("/api/me", {
				method: "PATCH",
				jar,
				headers: {
					"content-type": "application/json",
					origin: "https://elsewhere.example",
				},
				body: "{}",
			});
			const text = await foreign.text();
			expect(
				foreign.status === 403,
				"a foreign Origin was not refused",
				show("PATCH", "/api/me", foreign, text),
			);
			const own = await ctx.web.request("/api/me", {
				method: "PATCH",
				jar,
				headers: { "content-type": "application/json", origin: ctx.web.origin },
				body: "{}",
			});
			await own.text();
			expect(
				own.status !== 403,
				"the deployment's own Origin was refused",
				show("PATCH", "/api/me", own),
			);
			return pass(`foreign 403; own ${own.status}`);
		},
	},
	{
		group: "web",
		name: "a typed turn streams an answer",
		async run(ctx) {
			const jar = signedIn(ctx);
			const threadId = uuid();
			ctx.threads.add(threadId);
			const { res, stream, start, end } = await runTurn(
				ctx,
				jar,
				threadId,
				"Hello",
			);
			ctx.turns.push({ start, end });
			expect(
				res.status === 200,
				"the turn was refused",
				show("POST", "/api/copilotkit", res, stream),
			);
			expect(
				!stream.includes('"RUN_ERROR"'),
				"the turn failed",
				stream.slice(stream.indexOf('"RUN_ERROR"') - 200),
			);
			expect(
				stream.includes('"TEXT_MESSAGE_CONTENT"') &&
					stream.includes('"RUN_FINISHED"'),
				"no answer streamed to its end",
				stream.slice(0, 600),
			);
			return pass("TEXT_MESSAGE_CONTENT … RUN_FINISHED");
		},
	},
	{
		group: "web",
		name: "a conversation is listed, renamed, read and deleted",
		async run(ctx) {
			const jar = signedIn(ctx);
			const threadId = [...ctx.threads][0];
			if (!threadId)
				throw new Failed(
					"not checked: no conversation (the turn check did not make one)",
				);
			const listed = await ctx.web.request("/api/conversations", { jar });
			const list = await listed.text();
			expect(
				listed.status === 200 && list.includes(threadId),
				"the turn's conversation is not listed",
				show("GET", "/api/conversations", listed, list),
			);
			const path = `/api/conversations/${threadId}`;
			const renamed = await ctx.web.request(path, {
				method: "PATCH",
				jar,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "Verify deployment" }),
			});
			const r = await renamed.text();
			expect(
				renamed.status === 200,
				"the rename was refused",
				show("PATCH", path, renamed, r),
			);
			const read = await ctx.web.request(path, { jar });
			const thread = await read.text();
			expect(
				read.status === 200 && thread.includes("Hello"),
				"the conversation does not read back",
				show("GET", path, read, thread),
			);
			const deleted = await ctx.web.request(path, { method: "DELETE", jar });
			expect(
				deleted.status === 204,
				"the delete was refused",
				show("DELETE", path, deleted, await deleted.text()),
			);
			ctx.threads.delete(threadId);
			const again = await ctx.web.request(path, { jar });
			await again.text();
			expect(
				again.status === 404,
				"a deleted conversation still reads",
				show("GET", path, again),
			);
			return pass("listed, renamed, read, deleted, then 404");
		},
	},
	{
		group: "web",
		name: "the library lists its documents",
		async run(ctx) {
			const jar = signedIn(ctx);
			const res = await ctx.web.request("/api/library?query=onboarding", {
				jar,
			});
			const body = await res.text();
			expect(
				res.status === 200,
				"the library search was refused",
				show("GET", "/api/library?query=onboarding", res, body),
			);
			if ((ctx.env.SEED_SAMPLE_LIBRARY ?? "true").toLowerCase() === "false")
				return pass(
					"answers (SEED_SAMPLE_LIBRARY is false: no document expected)",
				);
			expect(
				body.includes('"Onboarding handbook"'),
				"the sample's documents are not listed",
				body.slice(0, 600),
			);
			return pass("the sample's Onboarding handbook is found");
		},
	},
	{
		group: "web",
		name: "a picture is served and revalidated",
		async run(ctx) {
			const jar = signedIn(ctx);
			if ((ctx.env.SEED_SAMPLE_LIBRARY ?? "true").toLowerCase() === "false")
				return skip(
					"SEED_SAMPLE_LIBRARY is false: no library is known to hold a picture",
				);
			const res = await ctx.web.request("/api/library", { jar });
			const text = await res.text();
			let body: { documents?: { thumbnailUrl?: string }[] } = {};
			try {
				body = JSON.parse(text);
			} catch {}
			expect(
				res.status === 200 && Array.isArray(body.documents),
				"the library did not answer a list of documents",
				show("GET", "/api/library", res, text),
			);
			const url = body.documents?.find((d) => d.thumbnailUrl)?.thumbnailUrl;
			expect(
				url,
				"the seeded sample holds pictures, and no document in the library offers one",
				text.slice(0, 600),
			);
			const first = await ctx.web.request(url as string, { jar });
			await first.arrayBuffer();
			const etag = first.headers.get("etag");
			expect(
				first.status === 200 &&
					(first.headers.get("content-type") ?? "").startsWith("image/") &&
					etag,
				"the picture has no ETag or is not an image",
				show("GET", url as string, first),
			);
			const again = await ctx.web.request(url as string, {
				jar,
				headers: { "if-none-match": etag as string },
			});
			await again.arrayBuffer();
			expect(
				again.status === 304,
				"the same validator did not answer 304",
				show("GET", url as string, again),
			);
			const star = await ctx.web.request(url as string, {
				jar,
				headers: { "if-none-match": "*" },
			});
			await star.arrayBuffer();
			expect(
				star.status === 200,
				"`If-None-Match: *` earned a 304",
				show("GET", url as string, star),
			);
			return pass("200 with an ETag, 304 on it, 200 on *");
		},
	},
	{
		group: "web",
		name: "the export downloads",
		async run(ctx) {
			const jar = signedIn(ctx);
			const res = await ctx.web.request("/api/account/export", { jar });
			const text = await res.text();
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {}
			// What a person keeps is never copied into a report: its size and shape only.
			const shape =
				parsed && typeof parsed === "object"
					? `keys ${Object.keys(parsed).join(", ")}`
					: "not an object";
			expect(
				res.status === 200 && parsed && typeof parsed === "object",
				"the export is not a JSON object",
				`GET /api/account/export → ${res.status}, ${text.length} bytes, ${shape}`,
			);
			return pass(`${text.length} bytes of JSON (${shape})`);
		},
	},
];

/** What a live session through the relay showed: its events in order, the errors it sent, how it ended and closed. */
export type LiveRun = {
	events: string[];
	/** The codes of the `error` events the session sent. */
	errors: string[];
	ending?: string;
	ended?: { reason: string; written: number };
	close?: number;
};

/**
 * A live session judged: it became ready, sent no error, ended for the
 * reason this run asked for (`client`) and closed normally. Silence is all it
 * hears, so nothing is said and no line need be written; any other end —
 * the service refusing the session's settings, the socket failing, the
 * service closing it, an allowance or a drain — is a voice that does not work.
 */
export function liveProblem(run: LiveRun): string | null {
	if (run.events[0] !== "ready") return "the session never became ready";
	if (run.errors.length)
		return `the session sent error ${run.errors.join(", ")}`;
	if (run.ending && run.ending !== "client")
		return `the session was ending for ${run.ending}, not the end this run asked for`;
	if (!run.ended) return "no ended message before the socket closed";
	if (run.ended.reason !== "client")
		return `the session ended ${run.ended.reason}, not client: the end this run asked for was not the end it got`;
	if (run.close !== 1000) return `the socket closed ${run.close}, not 1000`;
	return null;
}

/** One live session through the frontend's relay: start, a little silence, end. */
async function liveSession(
	origin: string,
	jar: Jar,
	threadId: string,
	timeoutMs = 60_000,
): Promise<LiveRun> {
	const url = `${origin.replace(/^http/, "ws")}/api/voice/live`;
	const socket = new WebSocket(url, {
		// Bun's WebSocket takes the handshake's headers, as a browser sends its own.
		headers: { cookie: jar.header(), origin },
	} as unknown as string[]);
	socket.binaryType = "arraybuffer";
	const events: string[] = [];
	const errors: string[] = [];
	let ending: string | undefined;
	let ended: { reason: string; written: number } | undefined;
	return await new Promise((done, failed) => {
		const timer = setTimeout(() => {
			socket.close();
			failed(new Failed("the session did not end in time", events.join("\n")));
		}, timeoutMs);
		socket.onopen = () =>
			socket.send(JSON.stringify({ type: "start", threadId }));
		socket.onmessage = (message) => {
			if (typeof message.data !== "string") return;
			const event = JSON.parse(message.data) as Record<string, Json>;
			events.push(event.type);
			if (event.type === "refused") {
				clearTimeout(timer);
				socket.close();
				failed(new Failed("the session was refused", message.data));
			} else if (event.type === "ready") {
				// A quarter of a second of silence: 24 kHz, 16-bit, mono, in 20 ms frames.
				for (let i = 0; i < 12; i++) socket.send(new ArrayBuffer(960));
				setTimeout(() => socket.send(JSON.stringify({ type: "end" })), 1_500);
			} else if (event.type === "stage-call") {
				socket.send(
					JSON.stringify({
						type: "tool-output",
						callId: event.callId,
						output: "shown",
					}),
				);
			} else if (event.type === "error") {
				errors.push(String(event.code ?? "unnamed"));
			} else if (event.type === "ending") {
				ending = String(event.reason);
			} else if (event.type === "ended") {
				ended = {
					reason: String(event.reason),
					written: Number(event.written),
				};
			}
		};
		socket.onerror = () => events.push("socket-error");
		socket.onclose = (close) => {
			clearTimeout(timer);
			done({ events, errors, ending, ended, close: close.code });
		};
	});
}

const VOICE: Check[] = [
	{
		group: "voice",
		name: "live voice is offered",
		async run(ctx) {
			const jar = signedIn(ctx);
			const res = await ctx.web.request("/api/voice/capability", { jar });
			const body = await res.text();
			expect(
				res.status === 200 && body.includes('"live":true'),
				"live voice is not offered",
				show("GET", "/api/voice/capability", res, body),
			);
			return pass("live: true");
		},
	},
	{
		group: "voice",
		name: "a live session opens, is sent silence and ends cleanly",
		async run(ctx) {
			const jar = signedIn(ctx);
			const threadId = uuid();
			ctx.threads.add(threadId);
			const session = await liveSession(ctx.web.origin, jar, threadId);
			const problem = liveProblem(session);
			expect(
				!problem,
				problem as string,
				`${session.events.join(" → ")}\nended ${JSON.stringify(session.ended ?? null)}, closed ${session.close}`,
			);
			return pass(
				`ready … ended (client, ${session.ended?.written} line(s) written), closed 1000, no error`,
			);
		},
	},
];

/** The Application Insights application id, from the connection string the apps send with. */
export function insightsApp(
	connection: string | undefined,
): string | undefined {
	return /ApplicationId=([0-9a-f-]+)/i.exec(connection ?? "")?.[1];
}

/** The role the backend's telemetry is sent under (`apps/backend/src/product.ts`). */
const BACKEND_ROLE = "assistant-backend";

/** How far the backend's clock and this machine's may be apart, either way. */
const CLOCK_SLACK_MS = 60_000;

/**
 * The query for this run's own usage rows. A usage row carries its turn only
 * as a tag of the id the backend minted for it, which no client is told, so
 * the run's rows are the backend's `llm_usage` rows written while one of the
 * run's turns was open: from its request to the end of its stream, widened
 * by the clocks' slack. Another caller's turn in the same seconds is counted
 * too; nothing in a row names the account or the conversation.
 */
export function usageQuery(ctx: Context): string {
	const at = (d: Date, by: number) =>
		`datetime(${new Date(d.getTime() + by).toISOString()})`;
	const windows = ctx.turns
		.map(
			(t) =>
				`timestamp between (${at(t.start, -CLOCK_SLACK_MS)} .. ${at(t.end, CLOCK_SLACK_MS)})`,
		)
		.join(" or ");
	return `dependencies | where name == "llm_usage" | where cloud_RoleName == "${BACKEND_ROLE}" | where ${windows} | summarize count() by name`;
}

const TELEMETRY: Check[] = [
	{
		group: "telemetry",
		name: "the run's model calls reached Application Insights",
		async run(ctx) {
			if (local(ctx)) return skip("a local run sends no telemetry");
			const app = insightsApp(ctx.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
			expect(
				app,
				"not checked: APPLICATIONINSIGHTS_CONNECTION_STRING names no ApplicationId to query",
			);
			if (ctx.options.signedOutOnly)
				return skip("--signed-out-only: no turn was run to look for");
			expect(
				ctx.turns.length,
				"not checked: no turn ran (the signed-in checks did not)",
			);
			const query = usageQuery(ctx);
			// Ingestion is minutes behind: asked every 30 s for up to five minutes.
			let rows: [string, number][] = [];
			for (let i = 0; i < 10; i++) {
				let answer: Json;
				try {
					answer = await queryInsights(
						ctx.az,
						ctx.env.AZURE_TENANT_ID,
						app as string,
						query,
						ctx.insights,
					);
				} catch (err) {
					const words =
						err instanceof Failed ? (err.evidence ?? err.message) : String(err);
					if (
						/not authorized|AuthorizationFailed|Forbidden|InsufficientAccess|InvalidToken|az login|^40[13] /im.test(
							words,
						)
					)
						throw new Failed(
							`not checked: the query is not permitted here: ${words.split("\n").pop()} (an identity that can read the component, signed in to the environment's tenant${ctx.env.AZURE_TENANT_ID ? `: az login --tenant ${ctx.env.AZURE_TENANT_ID}` : ""})`,
						);
					throw err;
				}
				rows = answer?.tables?.[0]?.rows ?? [];
				if (rows.some(([name, count]) => name === "llm_usage" && count > 0))
					break;
				await ctx.pause(30_000);
				if (ctx.interrupted)
					throw new Failed("not finished: the run was stopped while it waited");
			}
			const usage = rows.find(([name]) => name === "llm_usage")?.[1] ?? 0;
			expect(
				usage > 0,
				`no backend llm_usage row written while this run's ${ctx.turns.length} turn(s) were open arrived within five minutes`,
				`${query}\n${JSON.stringify(rows)}`,
			);
			return pass(
				`${usage} backend llm_usage row(s) written while this run's ${ctx.turns.length} turn(s) were open`,
			);
		},
	},
];

const here = import.meta.dir;

/** How long one ingest run may take: a mirror, an indexer run and a load. */
const INGEST_TIMEOUT_MS = 30 * 60_000;

/** How long a child's output is still read after it has exited. */
const OUTPUT_GRACE_MS = 2_000;

/** A stream read as it arrives: what has come so far, and when it ends. */
function collect(stream: ReadableStream<Uint8Array>) {
	const decoder = new TextDecoder();
	let text = "";
	const done = (async () => {
		for await (const chunk of stream)
			text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
	return { text: () => text, done };
}

/**
 * Ingest, run against the environment this run checks: `AZURE_ENV_NAME` is
 * the environment azd reads, so a run with `--env` never loads into the one
 * azd would otherwise default to.
 */
export async function runIngest(
	ctx: Context,
	args: string[],
): Promise<{ code: number; output: string }> {
	const command =
		ctx.ingest ??
		(process.platform === "win32"
			? ["pwsh", "-NoProfile", "-File", join(here, "ingest.ps1")]
			: ["bash", join(here, "ingest.sh")]);
	const env: Record<string, string> = { ...process.env } as Record<
		string,
		string
	>;
	const name = ctx.env.AZURE_ENV_NAME ?? ctx.options.env;
	if (name) env.AZURE_ENV_NAME = name;
	const child = Bun.spawn([...command, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: INGEST_TIMEOUT_MS,
	});
	// Known to the run while it lives: a signal is passed on to it and waited for,
	// and its output is read to the end meanwhile, so its own close is never cut short.
	ctx.children.add(child);
	try {
		const out = collect(child.stdout);
		const err = collect(child.stderr);
		const code = await child.exited;
		// Once it has exited, what it wrote is read for a moment more: a process
		// of its own left holding the pipe does not hold the run.
		await within(Promise.all([out.done, err.done]), OUTPUT_GRACE_MS);
		return {
			code: child.signalCode ? 124 : code,
			output: `${out.text()}\n${err.text()}`,
		};
	} finally {
		ctx.children.delete(child);
	}
}

const DESTRUCTIVE: Check[] = [
	{
		group: "destructive",
		name: "an erase ends every session of the account",
		async run(ctx) {
			const jar = signedIn(ctx);
			if (!ctx.session?.own)
				return skip(
					"the session is a given person's (VERIFY_SESSION_COOKIE): never erased by the run",
				);
			// Something of the account's own, for the account made after it to be held to.
			const marker = `verify-erased-${uuid()}`;
			const threadId = uuid();
			ctx.threads.add(threadId);
			const { res: wrote, stream } = await runTurn(ctx, jar, threadId, marker);
			expect(
				wrote.status === 200 && stream.includes('"RUN_FINISHED"'),
				"the account could not write a conversation to erase",
				show("POST", "/api/copilotkit", wrote, stream),
			);
			const earlier = jar.copy();
			const erased = await ctx.web.request("/api/account", {
				method: "DELETE",
				jar,
			});
			expect(
				erased.status === 204,
				"the erase was refused",
				show("DELETE", "/api/account", erased, await erased.text()),
			);
			ctx.made = ctx.made.filter((j) => j !== jar);
			ctx.threads.delete(threadId);
			ctx.erased = { threadId, marker };
			ctx.session = undefined;
			const after = await ctx.web.request("/api/conversations", {
				jar: earlier,
				keepCookies: true,
			});
			const body = await after.text();
			// The frontend reads its caller from the backend first and answers an
			// erased one as no caller at all; either code is the session refused.
			const code = /"code":"([^"]+)"/.exec(body)?.[1];
			expect(
				after.status === 401 &&
					(code === "account_erased" || code === "unauthenticated"),
				"a session from before the erase is not refused",
				show("GET", "/api/conversations", after, body),
			);
			const repeat = await ctx.web.request("/api/account", {
				method: "DELETE",
				jar: earlier,
				keepCookies: true,
			});
			await repeat.text();
			expect(
				repeat.status === 204,
				"the same session's repeat erase did not answer 204",
				show("DELETE", "/api/account", repeat),
			);
			return pass(
				`204; the earlier session's next call 401 ${code}; its repeat erase 204`,
			);
		},
	},
	{
		group: "destructive",
		name: "a sign-in after an erase reaches nothing of the erased account",
		async run(ctx) {
			if (ctx.mode.authMode !== "local")
				return skip("AUTH_MODE is entra: a script cannot sign in");
			const erased = ctx.erased;
			if (!erased)
				throw new Failed(
					"not checked: no erase ran (the erase check did not pass)",
				);
			const jar = await signInLocally(ctx);
			const export_ = await ctx.web.request("/api/account/export", { jar });
			const text = await export_.text();
			expect(
				export_.status === 200,
				"the new account cannot read its own data",
				`GET /api/account/export → ${export_.status}`,
			);
			expect(
				!text.includes(erased.marker) && !text.includes(erased.threadId),
				"the new account's export holds the erased account's conversation",
				`${text.length} bytes; the erased account's marker or conversation id is in them`,
			);
			const path = `/api/conversations/${erased.threadId}`;
			const old = await ctx.web.request(path, { jar });
			const body = await old.text();
			expect(
				old.status === 404,
				"the erased account's conversation is still read",
				show("GET", path, old, body),
			);
			return pass(
				"signed in again: the export holds nothing of the erased account, and its conversation is 404",
			);
		},
	},
	{
		group: "destructive",
		name: "ingest through --open-listener leaves the account closed",
		async run(ctx) {
			if (!ctx.mode.private)
				return skip("not private: the storage account is public by design");
			const [account] = need(ctx.env, "AZURE_STORAGE_ACCOUNT");
			const dir = mkdtempSync(join(tmpdir(), "verify-library-"));
			// A name of the run's own: a library an operator keeps is never mirrored over.
			const name = `verify-${uuid().slice(0, 8)}`;
			try {
				writeFileSync(
					join(dir, "check.md"),
					"# Verify\n\nA file a deployment check loads and removes.\n",
				);
				// Named before the load: one cut short leaves a library the clean-up must name.
				ctx.ingestLibrary = name;
				ctx.ingestBegun = true;
				const load = await runIngest(ctx, ["--open-listener", dir, name]);
				expect(
					load.code === 0,
					"ingest --open-listener failed",
					load.output.slice(-2000),
				);
				expect(
					load.output.includes(account as string),
					`ingest did not act on this environment's storage account ${account}`,
					load.output.slice(-2000),
				);
				const remove = await runIngest(ctx, [
					"--open-listener",
					"--remove",
					name,
				]);
				expect(
					remove.code === 0,
					"ingest --open-listener --remove failed",
					remove.output.slice(-2000),
				);
				ctx.ingestLibrary = undefined;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			const storage = CONTROL.find((c) =>
				c.name.startsWith("the storage account"),
			);
			const closed = await (storage as Check).run(ctx);
			expect(
				closed.status === "pass",
				`after the run: ${closed.detail}`,
				closed.evidence,
			);
			return pass(
				"loaded and removed a one-file library; the account is closed with no rule and no tag",
			);
		},
	},
];

export const CHECKS: Check[] = [
	...CONTROL,
	...WEB,
	...VOICE,
	...TELEMETRY,
	...DESTRUCTIVE,
];

/* ---- the run ---- */

export async function runChecks(
	checks: Check[],
	ctx: Context,
	log: (o: Outcome) => void = () => {},
): Promise<Outcome[]> {
	const outcomes = ctx.outcomes;
	ctx.planned = checks;
	try {
		for (const check of checks) {
			// A signal stops the run between checks: nothing more is begun.
			if (ctx.interrupted) break;
			const begun = performance.now();
			let result: Result;
			try {
				const running = check.run(ctx);
				ctx.current = running.catch(() => {});
				result = await running;
			} catch (err) {
				if (err instanceof Skip) result = skip(err.message);
				else if (err instanceof Failed)
					result = fail(err.message, err.evidence);
				else
					result = fail(
						err instanceof Error ? err.message : String(err),
						err instanceof Error ? err.stack : undefined,
					);
			}
			const outcome = {
				group: check.group,
				name: check.name,
				...result,
				ms: Math.round(performance.now() - begun),
			};
			outcomes.push(outcome);
			log(outcome);
		}
	} finally {
		await cleanUp(ctx, outcomes, log);
	}
	return outcomes;
}

/**
 * What the run made is taken back, whatever became of the checks. It runs
 * once: a signal that arrives while the checks' own clean-up runs waits for
 * that one instead of starting a second.
 */
function cleanUp(
	ctx: Context,
	outcomes: Outcome[],
	log: (o: Outcome) => void,
): Promise<void> {
	ctx.cleaning ??= takeBack(ctx, outcomes, log);
	return ctx.cleaning;
}

async function takeBack(
	ctx: Context,
	outcomes: Outcome[],
	log: (o: Outcome) => void,
) {
	const left: string[] = [];
	const jar = ctx.session?.jar;
	for (const threadId of ctx.threads) {
		if (!jar) break;
		const res = await ctx.web
			.request(`/api/conversations/${threadId}`, { method: "DELETE", jar })
			.catch(() => null);
		// A delete that got no answer is not known to have happened.
		if (!res || ![204, 404].includes(res.status))
			left.push(`conversation ${threadId} (${res?.status ?? "no answer"})`);
	}
	for (const made of ctx.made) {
		const res = await ctx.web
			.request("/api/account", { method: "DELETE", jar: made })
			.catch(() => null);
		if (!res || ![204, 401].includes(res.status))
			left.push(
				`the account named "Verify deployment" (${res?.status ?? "no answer"})`,
			);
	}
	if (ctx.ingestLibrary)
		left.push(
			`the library "${ctx.ingestLibrary}" may be loaded: remove it with scripts/ingest.sh --open-listener --remove ${ctx.ingestLibrary}`,
		);
	// A load through --open-listener that began: the account is read again, whatever became of it.
	if (ctx.ingestBegun) {
		const storage = CONTROL.find((c) =>
			c.name.startsWith("the storage account"),
		) as Check;
		const closed = await storage
			.run(ctx)
			.catch(
				(err: unknown): Result =>
					fail(err instanceof Error ? err.message : String(err)),
			);
		if (closed.status !== "pass")
			left.push(`the storage account may be open: ${closed.detail}`);
	}
	if (
		ctx.made.length ||
		ctx.threads.size ||
		ctx.ingestLibrary ||
		ctx.ingestBegun ||
		left.length
	) {
		const outcome: Outcome = {
			group: "web",
			name: "what the run made is taken back",
			...(left.length
				? fail(`left behind: ${left.join("; ")}`)
				: pass(
						`every account and conversation the run made is gone${ctx.ingestBegun ? "; the storage account is closed" : ""}`,
					)),
			ms: 0,
		};
		outcomes.push(outcome);
		log(outcome);
	}
}

export function selected(options: Options): Check[] {
	return CHECKS.filter((c) => {
		if (options.only && !options.only.includes(c.group)) return false;
		if (c.group === "voice" && !options.voice) return false;
		if (c.group === "destructive" && !options.destructive) return false;
		return true;
	});
}

/** A table cell: a pipe escaped, a line break a space. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

const MARK: Record<Status, string> = { pass: "✓", fail: "✗", skipped: "–" };

/** A stopped run: the signal, and the checks it never began. */
export type Interruption = { signal: string; notRun: string[] };

/** What a run comes to: a stopped run is neither a pass nor a fail of what it did not reach. */
export function verdict(
	outcomes: Outcome[],
	interrupted?: Interruption,
): "PASS" | "FAIL" | "INTERRUPTED" {
	if (interrupted) return "INTERRUPTED";
	return outcomes.some((o) => o.status === "fail") ? "FAIL" : "PASS";
}

export function markdown(
	outcomes: Outcome[],
	meta: Record<string, string>,
	interrupted?: Interruption,
): string {
	const count = (s: Status) => outcomes.filter((o) => o.status === s).length;
	const lines = [
		"# Deployment verification",
		"",
		...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
		`- **Result:** ${verdict(outcomes, interrupted)} — ${count("pass")} passed, ${count("fail")} failed, ${count("skipped")} skipped`,
		...(interrupted
			? [
					`- **Stopped by:** ${interrupted.signal}; not run: ${interrupted.notRun.length ? interrupted.notRun.join("; ") : "none"}`,
				]
			: []),
	];
	for (const group of GROUPS) {
		const mine = outcomes.filter((o) => o.group === group);
		if (!mine.length) continue;
		lines.push(
			"",
			`## ${group}`,
			"",
			"| | Check | Detail |",
			"| --- | --- | --- |",
		);
		for (const o of mine)
			lines.push(`| ${MARK[o.status]} | ${cell(o.name)} | ${cell(o.detail)} |`);
		for (const o of mine.filter((o) => o.evidence))
			lines.push("", `### ${o.name}`, "", "```", o.evidence ?? "", "```");
	}
	return `${lines.join("\n")}\n`;
}

/** A run's starting state: what a test builds to run checks without a command line. */
export function contextFor(
	env: Record<string, string>,
	options: Options,
	az: Az,
	origin = env.FRONTEND_URL ?? "https://frontend.invalid",
): Context {
	const ctx: Context = {
		env,
		mode: modeOf(env),
		options,
		az,
		web: browser(origin.replace(/\/$/, "")),
		started: new Date(),
		made: [],
		threads: new Set(),
		turns: [],
		probe: realProbe,
		outcomes: [],
		// A second at a time, so a signal ends a long wait at once.
		pause: async (ms) => {
			for (let left = ms; left > 0 && !ctx.interrupted; left -= 1_000)
				await Bun.sleep(Math.min(left, 1_000));
		},
		planned: [],
		children: new Set(),
	};
	return ctx;
}

async function main(argv: string[]): Promise<number> {
	let options: Options;
	try {
		options = parseArgs(argv);
	} catch (err) {
		console.error(`verify-deployment: ${(err as Error).message}`);
		return 2;
	}
	const read =
		await $`azd env get-values ${options.env ? ["--environment", options.env] : []}`
			.quiet()
			.nothrow();
	if (read.exitCode !== 0) {
		console.error(
			`verify-deployment: azd env get-values failed: ${read.stderr.toString().trim()}`,
		);
		return 2;
	}
	const env = parseEnvValues(read.stdout.toString());
	const frontend = env.FRONTEND_URL?.replace(/\/$/, "");
	if (!frontend) {
		console.error(
			"verify-deployment: FRONTEND_URL is not in the azd environment; run azd up first",
		);
		return 2;
	}
	const refused = refusedFrontend(frontend, options);
	if (refused) {
		console.error(`verify-deployment: ${refused}`);
		return 2;
	}
	const checks = selected(options);
	if (!checks.length) {
		console.error(
			"verify-deployment: the arguments select no check, and a run of none proves nothing",
		);
		return 2;
	}
	const cannot = refusedRun(
		env,
		options,
		checks,
		process.env.VERIFY_SESSION_COOKIE,
	);
	if (cannot) {
		console.error(`verify-deployment: ${cannot}`);
		return 2;
	}
	const ctx = contextFor(
		env,
		options,
		// Named whenever a selected group asks Azure (refusedRun holds it); a run that does not never calls az.
		realAz(env.AZURE_SUBSCRIPTION_ID ?? "(none: no az call is selected)"),
		frontend,
	);
	const log = (o: Outcome) =>
		console.log(
			`${MARK[o.status]} ${o.group.padEnd(11)} ${o.name} — ${o.detail}`,
		);
	const report = (outcomes: Outcome[]) =>
		writeReports(options, env, ctx, outcomes);
	onSignals(ctx, log, report);
	const outcomes = await runChecks(checks, ctx, log);
	return report(outcomes);
}

/** How long a child (ingest) is given to close up after a signal: its own exit path closes the account. */
const CHILD_GRACE_MS = 120_000;
/** How long the check running when a signal came is given to finish. */
const CURRENT_GRACE_MS = 30_000;

const within = (promise: Promise<unknown>, ms: number) =>
	Promise.race([promise, Bun.sleep(ms)]);

/**
 * Interrupted (SIGINT, SIGTERM): no further check is begun; a child the run
 * started is told and waited for, its output still read, so its own close
 * runs to its end; the check running is given a moment to finish; then what
 * the run made is taken back, the report says the run was interrupted and
 * what it did not reach, and the process exits 130 or 143.
 */
// fallow-ignore-next-line unused-export -- a test's child process imports it by path, to be signalled
export function onSignals(
	ctx: Context,
	log: (o: Outcome) => void,
	report: (outcomes: Outcome[]) => void,
	grace = { child: CHILD_GRACE_MS, current: CURRENT_GRACE_MS },
) {
	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)
		process.on(signal, () => {
			// A second signal while the first is handled changes nothing: the close is taken whole.
			if (ctx.interrupted) return;
			ctx.interrupted = signal;
			console.error(
				`verify-deployment: ${signal}: stopping; waiting for what is running to close`,
			);
			void (async () => {
				const children = [...ctx.children];
				for (const child of children) child.kill(signal);
				await within(
					Promise.all(children.map((child) => child.exited)),
					grace.child,
				);
				await within(ctx.current ?? Promise.resolve(), grace.current);
				await cleanUp(ctx, ctx.outcomes, log);
				report(ctx.outcomes);
				console.error(`verify-deployment: stopped by ${signal}`);
				process.exit(code);
			})();
		});
}

/** Why the frontend cannot be checked as given, or null when it can. */
export function refusedFrontend(
	frontend: string,
	options: Options,
): string | null {
	const url = new URL(frontend);
	const local = ["localhost", "127.0.0.1"].includes(url.hostname);
	if (options.allowHttp && !local)
		return `--allow-http is for a frontend on this machine, and ${frontend} is not one`;
	if (url.protocol !== "https:" && !local) return `${frontend} is not https`;
	if (url.protocol !== "https:" && !options.allowHttp)
		return `${frontend} is not https: add --allow-http for a frontend on this machine`;
	return null;
}

/** The checks a stopped run planned and never reached. */
export function interruptionOf(
	ctx: Context,
	outcomes: Outcome[],
): Interruption | undefined {
	if (!ctx.interrupted) return undefined;
	const reached = new Set(outcomes.map((o) => o.name));
	return {
		signal: ctx.interrupted,
		notRun: ctx.planned.map((c) => c.name).filter((n) => !reached.has(n)),
	};
}

export function writeReports(
	options: Options,
	env: Record<string, string>,
	ctx: Context,
	outcomes: Outcome[],
): number {
	const meta = {
		Environment: env.AZURE_ENV_NAME ?? options.env ?? "(default)",
		Mode: Object.entries(ctx.mode)
			.map(([k, v]) => `${k}=${v}`)
			.join(", "),
		Run: ctx.started.toISOString(),
		Frontend: ctx.web.origin,
	};
	const interrupted = interruptionOf(ctx, outcomes);
	const result = verdict(outcomes, interrupted);
	writeFileSync(`${options.report}.md`, markdown(outcomes, meta, interrupted));
	writeFileSync(
		`${options.report}.json`,
		`${JSON.stringify({ ...meta, result, interrupted, outcomes }, null, 2)}\n`,
	);
	const failed = outcomes.filter((o) => o.status === "fail").length;
	console.log(
		`\n${result}: ${outcomes.length - failed} of ${outcomes.length} without failure; reports in ${options.report}.md and ${options.report}.json`,
	);
	return result === "PASS" ? 0 : 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
