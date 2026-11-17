/**
 * ingest with `az`, `azd` and `curl` stood in for on PATH, each twin in
 * turn: the directory is
 * mirrored under its library name as the signed-in operator — the files
 * whose bytes their blobs do not already hold uploaded, and every blob it no
 * longer has deleted — the migrate job loads that prefix
 * and goes back to the deploy's steps whatever happened, a file of a format
 * no library takes is named and never sent, `--remove` takes a library
 * out, `--dry-run` only says what would change, and storage whose
 * public listener is off is refused with the two ways through before
 * anything is uploaded — or, with `--open-listener`, opened for the mirror
 * to this machine's address alone, by one firewall rule, and closed again
 * before the job, and on any exit. A hidden file and a symbolic link are
 * never sent.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standInAz } from "../hooks/stand-in-az";
import { eachTwin, runTwin, type Shell, spawnTwin } from "../hooks/twins";
import { indexedExtensions } from "../platform/knowledge/src/library/formats";
import { UNENFORCED_READERS } from "../platform/knowledge/src/library/load";

const SCRIPT = join(import.meta.dir, "ingest");

const ENVIRONMENT = {
	AZURE_SUBSCRIPTION_ID: "sub",
	AZURE_RESOURCE_GROUP: "rg",
	AZURE_STORAGE_ACCOUNT: "store",
	AZURE_STORAGE_LIBRARY_CONTAINER: "library",
	MIGRATE_JOB_NAME: "job",
	SEED_SAMPLE_LIBRARY: "true",
};

const GUIDE = "---\ntitle: Guide\n---\n\nText.\n";

function library(name = "handbook"): string {
	const dir = join(mkdtempSync(join(tmpdir(), "ingest-")), name);
	mkdirSync(join(dir, "pictures"), { recursive: true });
	writeFileSync(join(dir, "guide.md"), GUIDE);
	writeFileSync(join(dir, "pictures", "a.png"), "png");
	writeFileSync(join(dir, "access.json"), '{"*":{"groups":["all"]}}');
	writeFileSync(join(dir, "drafts.zip"), "zip");
	return dir;
}

/** What a run is asked for, said once and spelled as each twin takes it. */
interface Ask {
	dir?: string;
	name?: string;
	remove?: string;
	dryRun?: boolean;
	openListener?: boolean;
	closeLeftover?: boolean;
	ip?: string;
}
const FLAGS = {
	bash: {
		dryRun: "--dry-run",
		openListener: "--open-listener",
		closeLeftover: "--close-leftover",
		ip: "--ip",
		remove: "--remove",
	},
	pwsh: {
		dryRun: "-DryRun",
		openListener: "-OpenListener",
		closeLeftover: "-CloseLeftover",
		ip: "-Ip",
		remove: "-Remove",
	},
} as const;
function spelled(shell: Shell, ask: Ask): string[] {
	const flag = FLAGS[shell];
	return [
		...(ask.dryRun ? [flag.dryRun] : []),
		...(ask.openListener ? [flag.openListener] : []),
		...(ask.closeLeftover ? [flag.closeLeftover] : []),
		...(ask.ip ? [flag.ip, ask.ip] : []),
		...(ask.remove ? [flag.remove, ask.remove] : []),
		...(ask.dir ? [ask.dir] : []),
		...(ask.name ? [ask.name] : []),
	];
}

interface Options {
	status?: string;
	publicNetworkAccess?: string;
	defaultAction?: string;
	/** The `ingestListener` tag the account starts with. */
	tag?: string;
	blobs?: string[];
	ipRules?: string[];
	publicIp?: string | null;
	failing?: string;
	failingTimes?: number;
	slow?: string | string[];
	/** The job execution's log, as `job logs show` answers it. */
	log?: string;
	environment?: Record<string, string>;
	/** An earlier run's account and azd environment, to carry on from. */
	after?: { bin: string; values: string };
}

/**
 * The stand-ins a run is given, and what it is run with. `azd` keeps the
 * environment in a file: `env get-values` reads it and `env set` writes a
 * value into it, as azd does, so what one run leaves there the next reads.
 */
function prepared(shell: Shell, ask: Ask | string[], options: Options) {
	const values =
		options.after?.values ?? join(mkdtempSync(join(tmpdir(), "azd-")), "env");
	if (!options.after)
		writeFileSync(
			values,
			// A blank line among the values, as an environment file may hold one.
			`${Object.entries(options.environment ?? ENVIRONMENT)
				.map(([key, value]) => `${key}="${value}"`)
				.join("\n\n")}\n`,
		);
	const az = standInAz(options.status, {
		publicNetworkAccess: options.publicNetworkAccess,
		defaultAction: options.defaultAction,
		tag: options.tag,
		blobs: options.blobs,
		ipRules: options.ipRules,
		publicIp: options.publicIp,
		failing: options.failing,
		failingTimes: options.failingTimes,
		slow: options.slow,
		log: options.log,
		from: options.after?.bin,
		bin: {
			azd: `case "$1 $2" in
"env get-values") cat "${values}" ;;
"env set") grep -v "^$3=" "${values}" > "${values}.next" || true
	mv "${values}.next" "${values}"
	printf '%s="%s"\\n' "$3" "$4" >> "${values}" ;;
*) exit 1 ;;
esac`,
			// A retried call costs no time.
			sleep: "exit 0",
		},
	});
	// The script's temporary files, in a directory the test can look into.
	const temporary = mkdtempSync(join(tmpdir(), "ingest-tmp-"));
	return {
		args: Array.isArray(ask) ? ask : spelled(shell, ask),
		env: { ...az.env, TMPDIR: temporary },
		read: () => {
			const { publicNetworkAccess, ipRules, tag } = az.state();
			return {
				left: readdirSync(temporary),
				...az.read(),
				account: { publicNetworkAccess, ipRules },
				/** What the script says it has open, on the account itself. */
				tag,
				kept: { bin: az.bin, values },
			};
		},
	};
}

function ingest(shell: Shell, ask: Ask | string[], options: Options = {}) {
	const run = prepared(shell, ask, options);
	return { ...runTwin(shell, SCRIPT, run.args, run.env), ...run.read() };
}

/** A blob as the listing answers it: its name and the MD5 the service holds, base64. */
const held = (name: string, bytes: string) =>
	`${name}\t${createHash("md5").update(bytes).digest("base64")}`;

eachTwin(
	"uploads the directory under its own name, loads it through the job, and puts the job back on the deploy's steps",
	(shell) => {
		const dir = library();
		const run = ingest(shell, { dir });
		expect(run.exitCode).toBe(0);
		const upload = run.all.find((line) => line.includes("upload-batch"));
		expect(upload).toMatch(
			/^storage blob upload-batch --subscription sub --auth-mode login --account-name store --destination library --destination-path handbook --source \S+ --overwrite -o none$/,
		);
		// A copy of the files to send, never the operator's own directory.
		expect(upload).not.toContain(dir);
		expect(run.uploaded).toEqual(["access.json", "guide.md", "pictures/a.png"]);
		// The file of a format no library takes is named, and never sent.
		expect(run.said).toContain(
			`ingest: skipping ${dir}/drafts.zip, not a format a library takes`,
		);
		expect(run.said).toContain(
			`ingest: 3 changed file(s) of ${dir} uploaded to library/handbook/`,
		);
		expect(run.job).toEqual([
			"update --args src/job.ts library:handbook",
			"start",
			"update --args src/job.ts settings index skills agent library",
		]);
		expect(run.all.indexOf(upload as string)).toBeLessThan(
			run.all.findIndex((line) => line.includes("job update")),
		);
		expect(run.calls).not.toContain("blob delete");
		expect(run.said).toMatch(/library:handbook: exec-\d+ succeeded/);
		expect(run.subscribed).toBe(true);
		// A listener that is on is asked nothing more, and this machine's address is nobody's business.
		expect(run.lookups).toEqual([]);
	},
);

eachTwin(
	"only a file whose bytes its blob does not hold is sent, so the indexer reads nothing that did not change; a blob the directory no longer has is deleted after the upload",
	(shell) => {
		const dir = library();
		writeFileSync(join(dir, "notes with spaces.md"), "Notes.\n");
		const run = ingest(
			shell,
			{ dir },
			{
				blobs: [
					held("handbook/access.json", "an older manifest"),
					held("handbook/guide.md", GUIDE),
					"handbook/old notes.md\tx",
					held("handbook/pictures/a.png", "png"),
					"handbook/pictures/gone.png\tx",
					// Sent by a run before the script knew the formats: gone, like a file deleted.
					held("handbook/drafts.zip", "zip"),
				],
			},
		);
		expect(run.exitCode).toBe(0);
		const list = run.all.findIndex((line) => line.includes("blob list"));
		expect(run.all[list]).toBe(
			"storage blob list --subscription sub --auth-mode login --account-name store -c library --prefix handbook/ --num-results * --query [].[name, properties.contentSettings.contentMd5] -o tsv",
		);
		expect(run.uploaded).toEqual(["access.json", "notes with spaces.md"]);
		expect(run.said).toContain("2 changed file(s)");
		const deletes = run.all.filter((line) => line.includes("blob delete"));
		expect(deletes).toEqual([
			"storage blob delete --subscription sub --auth-mode login --account-name store -c library -n handbook/drafts.zip --delete-snapshots include -o none",
			"storage blob delete --subscription sub --auth-mode login --account-name store -c library -n handbook/old notes.md --delete-snapshots include -o none",
			"storage blob delete --subscription sub --auth-mode login --account-name store -c library -n handbook/pictures/gone.png --delete-snapshots include -o none",
		]);
		expect(run.said).toContain(
			`ingest: deleted library/handbook/old notes.md, which ${dir} no longer has`,
		);
		const upload = run.all.findIndex((line) => line.includes("upload-batch"));
		const job = run.all.findIndex((line) => line.includes("job update"));
		expect(list).toBeLessThan(upload);
		expect(upload).toBeLessThan(run.all.indexOf(deletes[0] as string));
		expect(run.all.indexOf(deletes[2] as string)).toBeLessThan(job);
		expect(run.job[0]).toBe("update --args src/job.ts library:handbook");
	},
);

eachTwin(
	"a blob whose name differs from a file's only by case is not that file's: the file is sent and the blob deleted",
	(shell) => {
		const dir = library();
		const run = ingest(
			shell,
			{ dir },
			{
				blobs: [
					held("handbook/access.json", '{"*":{"groups":["all"]}}'),
					held("handbook/Guide.md", GUIDE),
					held("handbook/pictures/a.png", "png"),
				],
			},
		);
		expect(run.exitCode).toBe(0);
		expect(run.uploaded).toEqual(["guide.md"]);
		expect(run.all.filter((line) => line.includes("blob delete"))).toEqual([
			"storage blob delete --subscription sub --auth-mode login --account-name store -c library -n handbook/Guide.md --delete-snapshots include -o none",
		]);
	},
);

eachTwin(
	"a library the container already holds whole uploads nothing, and the job still runs, to describe and index what an earlier run left",
	(shell) => {
		const dir = library();
		const run = ingest(
			shell,
			{ dir },
			{
				blobs: [
					held("handbook/access.json", '{"*":{"groups":["all"]}}'),
					held("handbook/guide.md", GUIDE),
					held("handbook/pictures/a.png", "png"),
				],
			},
		);
		expect(run.exitCode).toBe(0);
		expect(run.calls).not.toContain("upload-batch");
		expect(run.said).toContain(
			`library/handbook/ already holds every file of ${dir}`,
		);
		expect(run.job[0]).toBe("update --args src/job.ts library:handbook");
	},
);

eachTwin(
	"a listing that fails stops before anything is uploaded, deleted or run",
	(shell) => {
		const run = ingest(
			shell,
			{ dir: library() },
			{
				failing: "blob list",
				blobs: ["handbook/old.md"],
			},
		);
		expect(run.exitCode).not.toBe(0);
		expect(run.calls).not.toContain("upload-batch");
		expect(run.calls).not.toContain("blob delete");
		expect(run.job).toEqual([]);
	},
);

eachTwin(
	"removing a library deletes its prefix, takes its documents out through the job, and puts the job back",
	(shell) => {
		const run = ingest(
			shell,
			{ remove: "handbook" },
			{
				blobs: ["handbook/guide.md"],
				environment: { ...ENVIRONMENT, SEED_SAMPLE_LIBRARY: "false" },
			},
		);
		expect(run.exitCode).toBe(0);
		expect(run.calls).not.toContain("upload-batch");
		expect(run.all.filter((line) => line.includes("delete"))).toEqual([
			"storage blob delete-batch --subscription sub --auth-mode login --account-name store --source library --pattern handbook/* --delete-snapshots include -o none",
		]);
		expect(run.said).toContain("ingest: library/handbook/ deleted");
		expect(run.job).toEqual([
			"update --args src/job.ts remove-library:handbook",
			"start",
			"update --args src/job.ts settings index skills agent remove-library",
		]);
		expect(run.said).toMatch(/remove-library:handbook: exec-\d+ succeeded/);
		expect(run.subscribed).toBe(true);
	},
);

eachTwin(
	"a dry run names each file it would upload and each blob it would delete, and changes nothing",
	(shell) => {
		const dir = library();
		const load = ingest(
			shell,
			{ dryRun: true, dir },
			{
				blobs: [
					"handbook/guide.md",
					"handbook/old.md",
					held("handbook/pictures/a.png", "png"),
				],
			},
		);
		expect(load.exitCode).toBe(0);
		expect(load.said).toContain(
			`ingest: would upload ${dir}/access.json to library/handbook/access.json`,
		);
		expect(load.said).toContain(
			`ingest: would upload ${dir}/guide.md to library/handbook/guide.md`,
		);
		expect(load.said).toContain(
			`ingest: would upload 2 changed file(s) from ${dir} to library/handbook/`,
		);
		expect(load.said).not.toContain(`would upload ${dir}/pictures`);
		expect(load.said).toContain("ingest: would delete library/handbook/old.md");
		expect(load.said).toContain(
			`ingest: skipping ${dir}/drafts.zip, not a format a library takes`,
		);
		expect(load.said).not.toContain(`would upload ${dir}/drafts.zip`);
		expect(load.said).toContain(
			"ingest: dry run — nothing was uploaded or deleted, and the job did not run",
		);
		const remove = ingest(
			shell,
			{ dryRun: true, remove: "handbook" },
			{
				blobs: ["handbook/guide.md"],
			},
		);
		expect(remove.exitCode).toBe(0);
		expect(remove.said).toContain(
			"ingest: would delete library/handbook/guide.md",
		);
		for (const run of [load, remove]) {
			expect(run.calls).not.toContain("upload-batch");
			expect(run.calls).not.toContain("delete");
			expect(run.job).toEqual([]);
		}
	},
);

eachTwin(
	"a name given replaces the directory's, and a failed load still puts the job back",
	(shell) => {
		const run = ingest(
			shell,
			{ dir: library(), name: "policies-2026" },
			{
				status: "Failed",
				environment: { ...ENVIRONMENT, SEED_SAMPLE_LIBRARY: "false" },
			},
		);
		expect(run.exitCode).not.toBe(0);
		expect(run.calls).toContain("--destination-path policies-2026");
		expect(run.calls).toContain("job logs show");
		expect(run.job).toEqual([
			"update --args src/job.ts library:policies-2026",
			"start",
			"update --args src/job.ts settings index skills agent remove-library",
		]);
	},
);

/** The one question a run asks of the account first: its listener, its firewall's default and the tag. */
const SHOW =
	"storage account show --subscription sub -g rg -n store --query [publicNetworkAccess, networkRuleSet.defaultAction, tags.ingestListener || ''] -o tsv";

/** How each twin names itself and its switch in the two ways through. */
const AGAIN = {
	bash: { script: "./scripts/ingest.sh", open: " --open-listener" },
	pwsh: { script: "./scripts/ingest.ps1", open: " -OpenListener" },
} as const;

eachTwin(
	"storage with its public listener off is refused with the two ways through, and nothing but the question is asked of az",
	(shell) => {
		const dir = library();
		const run = ingest(shell, { dir }, { publicNetworkAccess: "Disabled" });
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain(
			"Storage at store.blob.core.windows.net has its public listener off and is not reachable from here. Either:",
		);
		const { script, open } = AGAIN[shell];
		expect(run.said).toContain(`      ${script} ${dir} handbook\n`);
		expect(run.said).toContain(`      ${script}${open} ${dir} handbook\n`);
		expect(run.all).toEqual([SHOW]);
		expect(run.lookups).toEqual([]);
		expect(run.job).toEqual([]);
	},
);

// The listener and one firewall rule together: the account denies by
// default, so a listener that is on admits nobody until a rule lets an
// address in, and the default is never what changes.
const IP = "203.0.113.7";
const RULES =
	"storage account network-rule list --subscription sub -g rg --account-name store --query ipRules[].ipAddressOrRange -o tsv";
const OPEN =
	"storage account update --subscription sub -g rg -n store --public-network-access Enabled -o none";
const ADMIT = `storage account network-rule add --subscription sub -g rg --account-name store --ip-address ${IP} -o none`;
const CLOSE =
	"storage account update --subscription sub -g rg -n store --public-network-access Disabled -o none";
const EXPEL = `storage account network-rule remove --subscription sub -g rg --account-name store --ip-address ${IP} -o none`;
const PROBE =
	"storage container show --subscription sub --auth-mode login --account-name store -n library -o none";
/** The tag a run of this machine writes: its run, the address, what it opened and when. */
const TAGGED = /^[0-9a-f]{8}:203\.0\.113\.7:listener\+rule:\d+$/;
/** A tag as an earlier run left it, so many seconds ago. */
const tagFrom = (ip: string, secondsAgo: number, what = "listener+rule") =>
	`0a1b2c3d:${ip}:${what}:${Math.floor(Date.now() / 1000) - secondsAgo}`;
const UNTAG = (tag: string) =>
	`tag update --subscription sub --resource-id /subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/store --operation Delete --tags ingestListener=${tag} -o none`;
/** Every call that changes who the account admits, in order. */
const admissions = (all: string[]) =>
	all.filter(
		(l) =>
			l.includes("storage account update") ||
			/network-rule (add|remove)/.test(l),
	);

eachTwin(
	"an opened listener admits this machine's address alone, for the mirror alone: on before the listing, off again after the last blob call and before the job runs",
	(shell) => {
		const dir = library();
		const run = ingest(
			shell,
			{ openListener: true, dir },
			{
				publicNetworkAccess: "Disabled",
				blobs: ["handbook/old.md\tx"],
			},
		);
		expect(run.exitCode).toBe(0);
		const at = (part: string) => run.all.findIndex((l) => l.includes(part));
		// The address is asked once, of the endpoint the usage names.
		expect(run.lookups).toEqual(["-fsS --max-time 10 https://api.ipify.org"]);
		expect(at(RULES)).toBeGreaterThan(at("storage account show"));
		expect(at(OPEN)).toBeGreaterThan(at(RULES));
		expect(at(ADMIT)).toBeGreaterThan(at(OPEN));
		// Nothing is listed until the container answers through the open listener.
		expect(at(PROBE)).toBeGreaterThan(at(ADMIT));
		expect(at(PROBE)).toBeLessThan(at("blob list"));
		expect(at("blob list")).toBeLessThan(at("upload-batch"));
		expect(at("blob delete")).toBeLessThan(at(CLOSE));
		expect(at(CLOSE)).toBeLessThan(at("job update"));
		expect(admissions(run.all)).toEqual([OPEN, ADMIT, CLOSE, EXPEL]);
		// The firewall's default is never what lets the mirror in.
		expect(run.calls).not.toContain("--default-action");
		expect(run.said).toContain(
			`ingest: store's public listener is on for the mirror, for ${IP} alone; it is off again before the job runs, or when this exits`,
		);
		expect(run.said).toContain("ingest: store's public listener is off again");
		expect(run.job[0]).toBe("update --args src/job.ts library:handbook");
	},
);

eachTwin(
	"an address given is the one admitted, and nobody is asked for it; a rule the account already holds for it is left where it was",
	(shell) => {
		const given = ingest(
			shell,
			{ openListener: true, ip: "198.51.100.9", dir: library() },
			{ publicNetworkAccess: "Disabled" },
		);
		expect(given.exitCode).toBe(0);
		expect(given.lookups).toEqual([]);
		expect(admissions(given.all)).toEqual([
			OPEN,
			ADMIT.replace(IP, "198.51.100.9"),
			CLOSE,
			EXPEL.replace(IP, "198.51.100.9"),
		]);
		const kept = ingest(
			shell,
			{ openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
				ipRules: ["192.0.2.1", IP],
			},
		);
		expect(kept.exitCode).toBe(0);
		expect(admissions(kept.all)).toEqual([OPEN, CLOSE]);
	},
);

eachTwin(
	"an address nobody can say stops the run before the listener is touched, naming the switch that gives it",
	(shell) => {
		for (const publicIp of [null, "2001:db8::7", "<html>"]) {
			const run = ingest(
				shell,
				{ openListener: true, dir: library() },
				{
					publicNetworkAccess: "Disabled",
					publicIp,
				},
			);
			expect(run.exitCode).toBe(1);
			expect(run.said).toContain(
				`ingest: https://api.ipify.org did not say this machine's public IPv4 address; pass it with ${FLAGS[shell].ip} <address>`,
			);
			expect(admissions(run.all)).toEqual([]);
			expect(run.job).toEqual([]);
		}
	},
);

eachTwin(
	"an opened listener is closed again when the mirror fails, and the job does not run",
	(shell) => {
		const run = ingest(
			shell,
			{ openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
				failing: "upload-batch",
			},
		);
		expect(run.exitCode).not.toBe(0);
		expect(admissions(run.all)).toEqual([OPEN, ADMIT, CLOSE, EXPEL]);
		// The rule goes, and then the tag that said it was there.
		expect(run.all.at(-2)).toBe(EXPEL);
		expect(run.all.at(-1)).toContain("tag update");
		expect(run.tag).toBe("");
		expect(run.job).toEqual([]);
	},
);

eachTwin(
	"a rule the service would not add is still taken out, with the listener, in case it landed",
	(shell) => {
		const run = ingest(
			shell,
			{ openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
				failing: "network-rule add",
			},
		);
		expect(run.exitCode).toBe(1);
		expect(admissions(run.all)).toEqual([OPEN, ADMIT, CLOSE, EXPEL]);
		expect(run.calls).not.toContain("blob list");
		expect(run.job).toEqual([]);
	},
);

eachTwin(
	"an opened listener is waited for before anything is listed, and given up on, closing it, when the account never answers",
	(shell) => {
		const late = ingest(
			shell,
			{ openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
				failing: "storage container show",
				failingTimes: 2,
			},
		);
		expect(late.exitCode).toBe(0);
		expect(late.all.filter((l) => l === PROBE)).toHaveLength(3);
		expect(late.all.lastIndexOf(PROBE)).toBeLessThan(
			late.all.findIndex((l) => l.includes("blob list")),
		);
		const never = ingest(
			shell,
			{ openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
				failing: "storage container show",
			},
		);
		expect(never.exitCode).toBe(1);
		expect(never.all.filter((l) => l === PROBE)).toHaveLength(24);
		expect(never.said).toContain(
			`ingest: store did not become reachable within two minutes of opening its listener for ${IP}. If az leaves this machine by another address (a proxy, a split tunnel), name that one with ${FLAGS[shell].ip} <address>`,
		);
		expect(never.calls).not.toContain("blob list");
		expect(never.all.at(-2)).toBe(EXPEL);
		expect(never.all.at(-1)).toContain("tag update");
		expect(never.tag).toBe("");
		expect(never.job).toEqual([]);
	},
);

eachTwin(
	"a close the service refuses is asked again; one that never lands is named with the commands that close it, and fails the run",
	(shell) => {
		const retried = ingest(
			shell,
			{ openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
				failing: "--public-network-access Disabled",
				failingTimes: 2,
			},
		);
		expect(retried.exitCode).toBe(0);
		expect(retried.all.filter((l) => l === CLOSE)).toHaveLength(3);
		expect(retried.all.filter((l) => l === EXPEL)).toHaveLength(1);
		expect(retried.said).toContain("public listener is off again");
		expect(retried.job[0]).toBe("update --args src/job.ts library:handbook");

		for (const ask of [
			{ openListener: true, dir: library() },
			// A dry run ends in the exit path, which closes too.
			{ dryRun: true, openListener: true, dir: library() },
		]) {
			const stuck = ingest(shell, ask, {
				publicNetworkAccess: "Disabled",
				failing: "--public-network-access Disabled",
			});
			expect(stuck.exitCode).toBe(1);
			expect(stuck.all.filter((l) => l === CLOSE)).toHaveLength(3);
			// The rule is asked for whatever became of the listener, and went.
			expect(stuck.all.filter((l) => l === EXPEL)).toHaveLength(1);
			expect(stuck.account).toEqual({
				publicNetworkAccess: "Enabled",
				ipRules: [],
			});
			expect(stuck.said).not.toContain("public listener is off again");
			expect(stuck.said).toContain(
				"ingest: THE PUBLIC LISTENER OF store IS STILL ON. Close it now:\n  az storage account update --subscription sub -g rg -n store --public-network-access Disabled\n",
			);
			// What is named is exactly what is left: the rule is not.
			expect(stuck.said).not.toContain("FIREWALL RULE");
			expect(stuck.said).not.toContain("az storage account network-rule");
			// The job reads the account from inside the network, and does not run beside an open listener.
			expect(stuck.job).toEqual([]);
			// The tag stays on the account, for the next run to see.
			expect(stuck.tag).toMatch(TAGGED);
		}

		// The listener closed, the rule alone refused: asked again, and named, alone, when it never goes.
		const ruled = ingest(
			shell,
			{ openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
				failing: "network-rule remove",
			},
		);
		expect(ruled.exitCode).toBe(1);
		expect(ruled.all.filter((l) => l === CLOSE)).toHaveLength(1);
		expect(ruled.all.filter((l) => l === EXPEL)).toHaveLength(3);
		expect(ruled.account).toEqual({
			publicNetworkAccess: "Disabled",
			ipRules: [IP],
		});
		expect(ruled.said).toContain(
			"ingest: THE FIREWALL RULE FOR 203.0.113.7 ON store IS STILL THERE. Remove it now:\n  az storage account network-rule remove --subscription sub -g rg --account-name store --ip-address 203.0.113.7\n",
		);
		expect(ruled.said).not.toContain("THE PUBLIC LISTENER");
		expect(ruled.job).toEqual([]);

		// A run that fails in the mirror closes on its way out, and leaves no tag.
		const failed = ingest(
			shell,
			{ openListener: true, dir: library() },
			{ publicNetworkAccess: "Disabled", failing: "blob list" },
		);
		expect(failed.exitCode).toBe(1);
		expect(failed.account).toEqual({
			publicNetworkAccess: "Disabled",
			ipRules: [],
		});
		expect(failed.tag).toBe("");
	},
);

eachTwin(
	"a hidden file, everything under a hidden directory and a symbolic link are never sent",
	(shell) => {
		const dir = library();
		const outside = mkdtempSync(join(tmpdir(), "ingest-outside-"));
		writeFileSync(join(outside, "payroll.md"), "Outside.\n");
		mkdirSync(join(outside, "folder"));
		writeFileSync(join(outside, "folder", "inner.md"), "Outside.\n");
		writeFileSync(join(dir, ".secret.md"), "Hidden.\n");
		mkdirSync(join(dir, ".drafts", "deeper"), { recursive: true });
		writeFileSync(join(dir, ".drafts", "pay.md"), "Hidden.\n");
		writeFileSync(join(dir, ".drafts", "deeper", "more.md"), "Hidden.\n");
		writeFileSync(join(dir, "pictures", ".thumb.png"), "png");
		symlinkSync(join(outside, "payroll.md"), join(dir, "linked.md"));
		symlinkSync(join(outside, "folder"), join(dir, "linked-folder"));
		const run = ingest(shell, { dir });
		expect(run.exitCode).toBe(0);
		expect(run.uploaded).toEqual(["access.json", "guide.md", "pictures/a.png"]);
		expect(run.said).toContain(
			`ingest: skipping ${dir}/linked.md, a symbolic link`,
		);
		expect(run.said).toContain(
			`ingest: skipping ${dir}/linked-folder, a symbolic link`,
		);
		expect(run.said).not.toContain("inner.md");
		expect(run.said).not.toContain(".secret.md");
		expect(run.said).not.toContain(".drafts");
		// A blob an earlier run made of one is gone, like a file deleted.
		const earlier = ingest(
			shell,
			{ dryRun: true, dir },
			{
				blobs: [held("handbook/.secret.md", "Hidden.\n")],
			},
		);
		expect(earlier.said).toContain(
			"ingest: would delete library/handbook/.secret.md",
		);
	},
);

eachTwin(
	"the copy of the files to send is gone when the run ends, the upload failed or not",
	(shell) => {
		for (const failing of [undefined, "upload-batch"]) {
			const run = ingest(shell, { dir: library() }, { failing });
			expect(run.exitCode === 0).toBe(failing === undefined);
			expect(run.calls).toContain("upload-batch");
			expect(run.left).toEqual([]);
		}
	},
);

eachTwin(
	"opening on a dry run, or a listener that is already on, changes the listener only when it was off",
	(shell) => {
		const dry = ingest(
			shell,
			{ dryRun: true, openListener: true, dir: library() },
			{
				publicNetworkAccess: "Disabled",
			},
		);
		expect(dry.exitCode).toBe(0);
		expect(admissions(dry.all)).toEqual([OPEN, ADMIT, CLOSE, EXPEL]);
		expect(dry.calls).not.toContain("upload-batch");
		expect(dry.job).toEqual([]);
		const open = ingest(shell, { openListener: true, dir: library() });
		expect(open.exitCode).toBe(0);
		expect(admissions(open.all)).toEqual([]);
		expect(open.lookups).toEqual([]);
	},
);

eachTwin(
	"a name the container cannot hold, a directory with nothing a library takes, no directory at all or an address that is not one stops before any call",
	(shell) => {
		const unsupported = mkdtempSync(join(tmpdir(), "ingest-unsupported-"));
		writeFileSync(join(unsupported, "notes.json"), "{}");
		const flag = FLAGS[shell];
		for (const ask of [
			{ dir: library("my docs") },
			{ dir: library(), name: "../up" },
			{ dir: mkdtempSync(join(tmpdir(), "ingest-empty-")) },
			{ dir: unsupported },
			{ dir: join(tmpdir(), "no-such-directory") },
			{ remove: "../up" },
			{ openListener: true, ip: "not-an-address", dir: library() },
			{ openListener: true, ip: "2001:db8::7", dir: library() },
		]) {
			const run = ingest(shell, ask);
			expect(run.exitCode, JSON.stringify(ask)).toBe(2);
			expect(run.all, JSON.stringify(ask)).toEqual([]);
		}
		// No directory, no library to remove and no leftover to close: the usage, from either twin.
		const bare = ingest(shell, []);
		expect(bare.exitCode).toBe(2);
		expect(bare.stderr).toContain("usage:");
		expect(bare.all).toEqual([]);
		// A command line that is not one of the forms. Bash's twin reads its
		// own arguments and answers 2 with the usage; PowerShell's binder
		// refuses these itself, before the script's first line, and its code is 1.
		for (const args of [
			[flag.remove],
			[flag.remove, "a", "b"],
			[shell === "bash" ? "--force" : "-Force", library()],
			[flag.openListener, flag.ip],
		]) {
			const run = ingest(shell, args);
			expect(run.exitCode, args.join(" ")).toBe(shell === "bash" ? 2 : 1);
			expect(run.all, args.join(" ")).toEqual([]);
		}
	},
);

eachTwin(
	"an environment that was never provisioned is named, not guessed at",
	(shell) => {
		const run = ingest(
			shell,
			{ dir: library() },
			{
				environment: {
					AZURE_SUBSCRIPTION_ID: "sub",
					AZURE_RESOURCE_GROUP: "rg",
				},
			},
		);
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain(
			"ingest: AZURE_STORAGE_ACCOUNT is not in the azd environment; run azd up first",
		);
		expect(run.all).toEqual([]);
	},
);

eachTwin(
	"an environment naming no subscription stops before any call, rather than asking az's default",
	(shell) => {
		const { AZURE_SUBSCRIPTION_ID: _, ...rest } = ENVIRONMENT;
		const run = ingest(shell, { dir: library() }, { environment: rest });
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain(
			"AZURE_SUBSCRIPTION_ID is not in the azd environment",
		);
		expect(run.all).toEqual([]);
	},
);

/** Waits, a twentieth of a second at a time, until `held` is so. */
async function until(held: () => boolean): Promise<void> {
	for (let tries = 0; tries < 600 && !held(); tries++) await Bun.sleep(50);
	expect(held()).toBe(true);
}
/** A run whose account never answers, slowly: caught in its wait for the listener. */
const WAITING = {
	publicNetworkAccess: "Disabled",
	failing: "storage container show",
	slow: "storage container show",
};

for (const signal of ["SIGTERM", "SIGHUP"] as const)
	eachTwin(
		`a run ended by ${signal} while its listener is open closes it and takes its rule out before it goes`,
		async (shell) => {
			const run = prepared(
				shell,
				{ openListener: true, dir: library() },
				WAITING,
			);
			const twin = spawnTwin(shell, SCRIPT, run.args, run.env);
			await until(() => run.read().all.includes(PROBE));
			twin.signal(signal);
			const ended = await twin.done;
			const after = run.read();
			expect(ended.exitCode).not.toBe(0);
			expect(after.account).toEqual({
				publicNetworkAccess: "Disabled",
				ipRules: [],
			});
			expect(admissions(after.all)).toEqual([OPEN, ADMIT, CLOSE, EXPEL]);
			expect(after.tag).toBe("");
			expect(after.calls).not.toContain("blob list");
			expect(after.job).toEqual([]);
		},
	);

eachTwin(
	"a run killed before it could close leaves its tag on the account: the next run touches nothing while it may still be uploading, and closes it when told the run is over",
	async (shell) => {
		const run = prepared(
			shell,
			{ openListener: true, dir: library() },
			WAITING,
		);
		const twin = spawnTwin(shell, SCRIPT, run.args, run.env);
		await until(() => run.read().all.includes(PROBE));
		twin.signal("SIGKILL");
		await twin.done;
		const left = run.read();
		expect(left.account).toEqual({
			publicNetworkAccess: "Enabled",
			ipRules: [IP],
		});
		expect(left.tag).toMatch(TAGGED);

		// Minutes later, any run, a dry one included: the tag may be a run still uploading.
		const next = ingest(
			shell,
			{ dryRun: true, dir: library() },
			{ after: left.kept },
		);
		expect(next.exitCode).toBe(1);
		expect(next.said).toContain(
			`ingest: another run of this script opened store for ${IP} 0 minute(s) ago and may still be uploading; nothing of it was touched.`,
		);
		expect(next.all).toEqual([SHOW]);
		expect(next.account).toEqual(left.account);
		expect(next.tag).toBe(left.tag);

		// Told the run is over: what the tag names is closed, the tag goes, and nothing else is done.
		const closed = ingest(shell, { closeLeftover: true }, { after: left.kept });
		expect(closed.exitCode).toBe(0);
		expect(closed.said).toContain(
			`ingest: closing what a run from ${IP} left open on store 0 minute(s) ago: its firewall rule and its public listener`,
		);
		expect(closed.all).toEqual([SHOW, CLOSE, EXPEL, UNTAG(left.tag), SHOW]);
		expect(closed.account).toEqual({
			publicNetworkAccess: "Disabled",
			ipRules: [],
		});
		expect(closed.tag).toBe("");
		expect(closed.job).toEqual([]);
	},
	120_000,
);

eachTwin(
	"a tag over an hour old is a run that ended: one for this machine's address is closed before anything else, one for another's is left for whoever knows it is over",
	(shell) => {
		const open = {
			publicNetworkAccess: "Enabled",
			defaultAction: "Deny",
		};
		// This machine's address, as the lookup says it: closed, then the run goes on as asked.
		const own = tagFrom(IP, 3700);
		const mine = ingest(
			shell,
			{ dir: library() },
			{ ...open, ipRules: [IP], tag: own },
		);
		expect(mine.said).toContain(
			`ingest: closing what a run from ${IP} left open on store 61 minute(s) ago: its firewall rule and its public listener`,
		);
		expect(mine.all.slice(0, 5)).toEqual([
			SHOW,
			CLOSE,
			EXPEL,
			UNTAG(own),
			SHOW,
		]);
		expect(mine.lookups).toHaveLength(1);
		expect(mine.account).toEqual({
			publicNetworkAccess: "Disabled",
			ipRules: [],
		});
		expect(mine.tag).toBe("");
		// The account is private again, and this run did not ask to open it.
		expect(mine.exitCode).toBe(1);
		expect(mine.said).toContain("has its public listener off");

		// Another machine's: this one sees the tag all the same, and touches nothing.
		const other = tagFrom("198.51.100.9", 3700);
		const theirs = ingest(
			shell,
			{ dir: library() },
			{ ...open, ipRules: ["198.51.100.9"], tag: other },
		);
		expect(theirs.exitCode).toBe(1);
		expect(theirs.said).toContain(
			"ingest: a run of this script opened store for 198.51.100.9 61 minute(s) ago and did not close it, and that is not this machine's address, so nothing of it was touched.",
		);
		expect(theirs.all).toEqual([SHOW]);
		expect(theirs.tag).toBe(other);
		// Told it is over, any machine closes it: the rule the tag names, and no other.
		const told = ingest(
			shell,
			{ closeLeftover: true },
			{ ...open, ipRules: ["198.51.100.9", "192.0.2.44"], tag: other },
		);
		expect(told.exitCode).toBe(0);
		expect(told.account).toEqual({
			publicNetworkAccess: "Disabled",
			ipRules: ["192.0.2.44"],
		});
		expect(told.tag).toBe("");
		expect(told.lookups).toEqual([]);
	},
	120_000,
);

eachTwin(
	"an account made public since is left public: the rule the tag names goes, and its listener is not this script's to turn off",
	(shell) => {
		const own = tagFrom(IP, 3700);
		const run = ingest(
			shell,
			{ dir: library() },
			{
				publicNetworkAccess: "Enabled",
				defaultAction: "Allow",
				ipRules: [IP],
				tag: own,
			},
		);
		expect(run.said).toContain(
			"ingest: store's firewall no longer denies by default, so its listener is left on",
		);
		expect(admissions(run.all)).toEqual([EXPEL]);
		expect(run.account).toEqual({
			publicNetworkAccess: "Enabled",
			ipRules: [],
		});
		expect(run.tag).toBe("");
		// The load then runs against the public account, as it was asked.
		expect(run.exitCode).toBe(0);
		expect(run.job[0]).toBe("update --args src/job.ts library:handbook");
	},
);

eachTwin(
	"a tag this script did not write says nothing of what to close: a run refuses until it is gone, and taking it off touches nothing else",
	(shell) => {
		for (const tag of ["none", `0a1b2c3d:${IP}:everything:17`, "listener"]) {
			const state = {
				publicNetworkAccess: "Enabled",
				defaultAction: "Allow",
				ipRules: [IP],
				tag,
			};
			const run = ingest(shell, { dir: library() }, state);
			expect(run.exitCode, tag).toBe(1);
			expect(run.said, tag).toContain(
				`ingest: store carries a tag ingestListener=${tag} that this script did not write`,
			);
			expect(run.said, tag).toContain(UNTAG(tag).replace(" -o none", ""));
			expect(run.all, tag).toEqual([SHOW]);

			const told = ingest(shell, { closeLeftover: true }, state);
			expect(told.exitCode, tag).toBe(0);
			expect(told.all, tag).toEqual([SHOW, UNTAG(tag), SHOW]);
			expect(told.account, tag).toEqual({
				publicNetworkAccess: "Enabled",
				ipRules: [IP],
			});
			expect(told.tag, tag).toBe("");
		}
		// With nothing left, being told to close says so and changes nothing.
		const nothing = ingest(shell, { closeLeftover: true });
		expect(nothing.exitCode).toBe(0);
		expect(nothing.said).toContain(
			"ingest: store carries no ingestListener tag: no run of this script left it open",
		);
		expect(nothing.all).toEqual([SHOW]);
	},
	120_000,
);

eachTwin(
	"a second run beside one that is uploading leaves it alone, and the first still closes what it opened",
	async (shell) => {
		const first = prepared(
			shell,
			{ openListener: true, dir: library() },
			WAITING,
		);
		const twin = spawnTwin(shell, SCRIPT, first.args, first.env);
		await until(() => first.read().all.includes(PROBE));
		// The second run reads the account as the first has it now.
		const second = ingest(
			shell,
			{ dryRun: true, dir: library() },
			{ after: first.read().kept },
		);
		expect(second.exitCode).toBe(1);
		expect(second.said).toContain("may still be uploading");
		expect(second.all).toEqual([SHOW]);
		twin.signal("SIGTERM");
		await twin.done;
		const after = first.read();
		expect(after.account).toEqual({
			publicNetworkAccess: "Disabled",
			ipRules: [],
		});
		expect(after.tag).toBe("");
	},
	120_000,
);

eachTwin(
	"a second signal while the account is being closed does not end the close",
	async (shell) => {
		const run = prepared(
			shell,
			{ openListener: true, dir: library() },
			{
				...WAITING,
				slow: ["storage container show", "--public-network-access Disabled"],
			},
		);
		const twin = spawnTwin(shell, SCRIPT, run.args, run.env);
		await until(() => run.read().all.includes(PROBE));
		twin.signal("SIGTERM");
		// The close has begun: its first call is being answered, slowly.
		await until(() => run.read().all.includes(CLOSE));
		twin.signal("SIGTERM");
		const ended = await twin.done;
		const after = run.read();
		expect(ended.exitCode).not.toBe(0);
		expect(admissions(after.all)).toEqual([OPEN, ADMIT, CLOSE, EXPEL]);
		expect(after.account).toEqual({
			publicNetworkAccess: "Disabled",
			ipRules: [],
		});
		expect(after.tag).toBe("");
	},
	120_000,
);

eachTwin(
	"a call the service refuses is named in the script's own words, by either twin, and what was opened is closed",
	(shell) => {
		for (const [failing, said] of [
			["network-rule list", "could not read the firewall rules of store"],
			["tag update", "could not tag store as open, so nothing was opened"],
			[
				"--public-network-access Enabled",
				"could not open the listener of store",
			],
			["network-rule add", `could not let ${IP} through the firewall of store`],
			["blob list", "could not list library/handbook/"],
		] as const) {
			const run = ingest(
				shell,
				{ openListener: true, dir: library() },
				{ publicNetworkAccess: "Disabled", failing },
			);
			expect(run.exitCode, failing).toBe(1);
			expect(run.stderr, failing).toContain(`ingest: ${said}`);
			expect(run.account.ipRules, failing).toEqual([]);
			expect(run.job, failing).toEqual([]);
		}
		// Nothing is opened under a tag that could not be written.
		const untagged = ingest(
			shell,
			{ openListener: true, dir: library() },
			{ publicNetworkAccess: "Disabled", failing: "tag update" },
		);
		expect(admissions(untagged.all)).toEqual([]);
		expect(untagged.account.publicNetworkAccess).toBe("Disabled");
	},
	120_000,
);

eachTwin(
	"an address written with leading zeros is the same address: one rule, asked for, compared and tagged as the firewall holds it",
	(shell) => {
		const run = ingest(
			shell,
			{ openListener: true, ip: "008.8.8.08", dir: library() },
			{ publicNetworkAccess: "Disabled" },
		);
		expect(run.exitCode).toBe(0);
		expect(admissions(run.all)).toEqual([
			OPEN,
			ADMIT.replace(IP, "8.8.8.8"),
			CLOSE,
			EXPEL.replace(IP, "8.8.8.8"),
		]);
		// The address as written, never a bare "008", which a tag's random id or time may hold.
		expect(run.calls).not.toMatch(/008\.8|\.08\b/);
		// A rule the account already holds for it is its operator's, however this run wrote the address.
		const kept = ingest(
			shell,
			{ openListener: true, ip: "008.8.8.08", dir: library() },
			{ publicNetworkAccess: "Disabled", ipRules: ["8.8.8.8"] },
		);
		expect(kept.exitCode).toBe(0);
		expect(admissions(kept.all)).toEqual([OPEN, CLOSE]);
		expect(kept.account.ipRules).toEqual(["8.8.8.8"]);
	},
);

eachTwin(
	"a file with a second name in the file system is an ordinary file under each, and a bracket in a name is a character of it",
	(shell) => {
		const dir = library("docs[v2]");
		linkSync(join(dir, "guide.md"), join(dir, "copy.md"));
		writeFileSync(join(dir, "report[1].pdf"), "pdf");
		mkdirSync(join(dir, "year [2024]"));
		writeFileSync(join(dir, "year [2024]", "q[1].md"), "Text.\n");
		const run = ingest(shell, { dir, name: "docs" });
		expect(run.exitCode).toBe(0);
		expect(run.said).not.toContain("a symbolic link");
		expect(run.uploaded).toEqual([
			"access.json",
			"copy.md",
			"guide.md",
			"pictures/a.png",
			"report[1].pdf",
			"year [2024]/q[1].md",
		]);
		expect(run.said).toContain(
			`ingest: 6 changed file(s) of ${dir} uploaded to library/docs/`,
		);
		expect(run.calls).not.toContain("blob delete");
	},
);

eachTwin(
	"an account that cannot be read stops the run: it is never taken for one whose listener is on",
	(shell) => {
		const run = ingest(
			shell,
			{ dir: library() },
			{ publicNetworkAccess: "Disabled", failing: "storage account show" },
		);
		expect(run.exitCode).toBe(1);
		expect(run.said).toContain("ingest: could not read store");
		expect(run.all).toEqual([SHOW]);
		expect(run.job).toEqual([]);
	},
);

eachTwin(
	"an address that is not a public one is refused before the listener is touched, given or looked up",
	(shell) => {
		for (const ip of ["256.1.1.1", "999.1.1.1"]) {
			const run = ingest(shell, { openListener: true, ip, dir: library() });
			expect(run.exitCode, ip).toBe(2);
			expect(run.all, ip).toEqual([]);
		}
		for (const ip of [
			"10.1.2.3",
			"172.16.0.9",
			"172.31.255.1",
			"192.168.1.5",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.1.1",
			"0.1.2.3",
			"224.0.0.1",
		]) {
			const run = ingest(shell, { openListener: true, ip, dir: library() });
			expect(run.exitCode, ip).toBe(2);
			expect(run.said, ip).toContain(
				`ingest: ${ip} is not a public address, and a storage firewall rule admits no other`,
			);
			expect(run.all, ip).toEqual([]);
		}
		// The edges of the ranges are public, and admitted.
		for (const ip of ["172.32.0.1", "100.128.0.1", "11.0.0.1"]) {
			const run = ingest(
				shell,
				{ openListener: true, ip, dir: library() },
				{ publicNetworkAccess: "Disabled" },
			);
			expect(run.exitCode, ip).toBe(0);
			expect(admissions(run.all)[1], ip).toBe(ADMIT.replace(IP, ip));
		}
		const looked = ingest(
			shell,
			{ openListener: true, dir: library() },
			{ publicNetworkAccess: "Disabled", publicIp: "10.0.0.5" },
		);
		expect(looked.exitCode).toBe(1);
		expect(looked.said).toContain(
			"https://api.ipify.org did not say this machine's public IPv4 address",
		);
		expect(admissions(looked.all)).toEqual([]);
		expect(looked.account.publicNetworkAccess).toBe("Disabled");
		expect(looked.tag).toBe("");
	},
	120_000,
);

/** The script's own line of formats, as `formatOf` lists them: one fact, held here to its source. */
const FORMATS = indexedExtensions().replaceAll(".", "").split(",");

test("both scripts name exactly the formats the job takes", () => {
	const line = `'${FORMATS.join("|")}'`;
	expect(readFileSync(`${SCRIPT}.sh`, "utf8")).toContain(`formats=${line}`);
	expect(readFileSync(`${SCRIPT}.ps1`, "utf8")).toContain(`$formats = ${line}`);
});

test("both scripts look for the job's own words for readers nothing enforces", () => {
	expect(
		readFileSync(join(import.meta.dir, "..", "hooks", "job.sh"), "utf8"),
	).toContain(`unenforced_mark="${UNENFORCED_READERS}"`);
	expect(
		readFileSync(join(import.meta.dir, "..", "hooks", "job.ps1"), "utf8"),
	).toContain(`$UnenforcedMark = '${UNENFORCED_READERS}'`);
});

eachTwin(
	"a load whose readers nothing enforces is said on the operator's screen, and the run still succeeds; a load that names none, or a removal, says nothing of it",
	(shell) => {
		const line = `[library] ${UNENFORCED_READERS}: 1 file(s) under handbook/ name readers short of everybody, and access control is off`;
		const log = `[library] described handbook/pay.md\n${line}\n[library:handbook] 1 described\n`;
		const warned = ingest(shell, { dir: library() }, { log });
		expect(warned.exitCode).toBe(0);
		expect(warned.calls).toContain(
			"containerapp job logs show --subscription sub -g rg -n job --execution exec-",
		);
		expect(warned.stderr).toContain(
			`library:handbook: ${UNENFORCED_READERS}. The library names readers and access control is off`,
		);
		expect(warned.stderr).toContain(line);
		expect(warned.job).toEqual([
			"update --args src/job.ts library:handbook",
			"start",
			"update --args src/job.ts settings index skills agent library",
		]);

		const quiet = ingest(
			shell,
			{ dir: library() },
			{ log: "[library:handbook] 3 described\n" },
		);
		expect(quiet.exitCode).toBe(0);
		expect(quiet.said).not.toContain(UNENFORCED_READERS);

		const removed = ingest(shell, { remove: "handbook" }, { log });
		expect(removed.exitCode).toBe(0);
		expect(removed.calls).not.toContain("job logs show");
		expect(removed.said).not.toContain(UNENFORCED_READERS);
	},
);

eachTwin(
	"a log that cannot be read leaves the load as it succeeded",
	(shell) => {
		const run = ingest(shell, { dir: library() }, { failing: "job logs show" });
		expect(run.exitCode).toBe(0);
		expect(run.said).toMatch(/library:handbook: exec-\d+ succeeded/);
		expect(run.said).not.toContain(UNENFORCED_READERS);
	},
);

eachTwin(
	"a file of every format the job takes is sent, in either case, with the two manifests and nothing else",
	(shell) => {
		const dir = join(mkdtempSync(join(tmpdir(), "ingest-")), "formats");
		mkdirSync(dir);
		const names = [
			...FORMATS.map((format, at) =>
				at % 2 ? `file.${format}` : `FILE.${format.toUpperCase()}`,
			),
			"access.json",
			"catalog.json",
		];
		for (const name of [...names, "notes.json", "archive.tar.gz", "md"])
			writeFileSync(join(dir, name), name);
		const run = ingest(shell, { dir });
		expect(run.exitCode).toBe(0);
		expect(run.uploaded).toEqual([...names].sort());
	},
);
