import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An `az` on PATH that records every call and answers the migrate job's
 * three questions: `job start` names an execution, `execution show` gives
 * `status`, and `storage account show` gives `publicNetworkAccess`;
 * `network-rule list` answers the firewall's `ipRules`, one a line, and
 * `blob list` answers `blobs`, one a line; a call containing `failing`
 * fails, every time or, with `failingTimes`, that many times and then no
 * more. The account is kept as the calls leave it: an update of the
 * listener is what the next `storage account show` answers, and a rule
 * added or removed is in or out of the next `network-rule list`, so a test
 * can read the state a run ended in (`state()`) and hand it to the next
 * (`from`). The account also keeps its firewall's default action and the one
 * tag the ingest script writes on it (`ingestListener`), which `tag update`
 * merges or deletes and a `storage account show` that asks for it answers
 * beside the listener, a value a line. A call of a command the scripts use is held to the flags the
 * real command takes (`FLAGS`): one it does not take is refused as az
 * refuses it, with exit 2, so a mistyped flag fails a test in either twin.
 * A call containing `slow` waits a third of a second before it answers,
 * for a test that must catch a run in the middle. Beside it a `curl` that
 * answers `publicIp` to whoever asks this
 * machine's address, or fails when there is none to say. Both are programs
 * on PATH, so bash and PowerShell find them alike. What a test reads back:
 * every call, the job's updates and starts in order (without the
 * subscription every call names), the files each `upload-batch` found in
 * its `--source` when it ran, the addresses `curl` was asked, and whether
 * every call named the subscription. A container app's `containerapp show`
 * answers the first probe's type with `heldProbe` (none unless given), and
 * its container with no probes, as the extension's later API version has it
 * (an `imageType` the hooks' PATCH version refuses); a `rest --method get`
 * answers the container as that version has it. Either merges the probes a
 * query names in a JMESPath literal as az would; the body each `rest` call
 * sent (`--body @file`) is read back as `bodies`. `job logs show` answers
 * `log`, the execution's log, nothing unless given.
 */
/** Every flag every az call takes, whatever the command. */
const EVERYWHERE = "--subscription --query --output -o --only-show-errors";
/**
 * The flags of each command the scripts call, as the real CLI names them.
 * A command not listed is not checked.
 */
const FLAGS: Record<string, string> = {
	"storage account show": "--name -n --resource-group -g",
	"tag update": "--resource-id --operation --tags",
	"storage account update":
		"--name -n --resource-group -g --public-network-access --default-action",
	"storage account network-rule list": "--account-name -n --resource-group -g",
	"storage account network-rule add":
		"--account-name -n --resource-group -g --ip-address",
	"storage account network-rule remove":
		"--account-name -n --resource-group -g --ip-address",
	"storage container show": "--name -n --account-name --auth-mode",
	"storage blob list":
		"--container-name -c --account-name --auth-mode --prefix --num-results",
	"storage blob delete":
		"--container-name -c --name -n --account-name --auth-mode --delete-snapshots",
	"storage blob delete-batch":
		"--source -s --pattern --account-name --auth-mode --delete-snapshots",
	"storage blob upload-batch":
		"--destination -d --destination-path --source -s --overwrite --account-name --auth-mode",
	"containerapp show": "--name -n --resource-group -g",
	rest: "--method -m --url -u --url-parameters --body -b --headers",
	"containerapp job update":
		"--name -n --resource-group -g --args --command --image --set-env-vars",
	"containerapp job start": "--name -n --resource-group -g",
	"containerapp job execution show":
		"--name -n --resource-group -g --job-execution-name",
	"containerapp job logs show":
		"--name -n --resource-group -g --execution --container --tail --follow",
};

export function standInAz(
	status = "Succeeded",
	extra: {
		publicNetworkAccess?: string;
		/** The firewall's default: Deny on an account whose listener is off unless said otherwise. */
		defaultAction?: string;
		/** The `ingestListener` tag the account starts with. */
		tag?: string;
		blobs?: string[];
		ipRules?: string[];
		publicIp?: string | null;
		failing?: string;
		failingTimes?: number;
		/** A call containing this, or any of these, waits a third of a second first. */
		slow?: string | string[];
		bin?: Record<string, string>;
		/** The directory an earlier stand-in kept its account in, to carry on from. */
		from?: string;
		/** The type of the first probe a container app holds; none unless given. */
		heldProbe?: string;
		/** What `job logs show` answers: the execution's log. */
		log?: string;
	} = {},
) {
	const bin = mkdtempSync(join(tmpdir(), "stand-in-az-"));
	const kept = (file: string, fresh: string) =>
		extra.from ? readFileSync(join(extra.from, file), "utf8") : fresh;
	const calls = join(bin, "calls");
	writeFileSync(calls, "");
	const blobs = join(bin, "blobs");
	writeFileSync(blobs, (extra.blobs ?? []).map((name) => `${name}\n`).join(""));
	const uploads = join(bin, "uploads");
	writeFileSync(uploads, "");
	const rules = join(bin, "rules");
	writeFileSync(
		rules,
		kept("rules", (extra.ipRules ?? []).map((ip) => `${ip}\n`).join("")),
	);
	const access = join(bin, "access");
	writeFileSync(
		access,
		kept("access", `${extra.publicNetworkAccess ?? "Enabled"}\n`),
	);
	const action = join(bin, "action");
	writeFileSync(
		action,
		kept(
			"action",
			`${extra.defaultAction ?? (extra.publicNetworkAccess === "Disabled" ? "Deny" : "Allow")}\n`,
		),
	);
	const tag = join(bin, "tag");
	writeFileSync(tag, kept("tag", `${extra.tag ?? ""}\n`));
	const bodies = join(bin, "bodies");
	writeFileSync(bodies, "");
	// The container as the API version the hooks PATCH with answers it; az
	// containerapp show reads a later one, which adds a property that
	// version refuses.
	const container =
		'{"name":"app","image":"registry/app:1","env":[{"name":"PORT","value":"1"}]}';
	const shown = container.replace(/}$/, ',"imageType":"ContainerImage"}');
	const log = join(bin, "log");
	writeFileSync(log, extra.log ?? "");
	const lookups = join(bin, "lookups");
	writeFileSync(lookups, "");
	const failures = join(bin, "failures");
	writeFileSync(failures, "");
	const failed =
		extra.failingTimes === undefined
			? "exit 1"
			: `if [ "$(wc -l < "${failures}" | tr -d ' ')" -lt ${extra.failingTimes} ]; then echo x >> "${failures}"; exit 1; fi`;
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub(
		"az",
		`echo "$*" >> "${calls}"
allowed=""
case "$*" in
${Object.entries(FLAGS)
	// The longest name first: `network-rule list` before `storage account …`.
	.sort(([a], [b]) => b.length - a.length)
	.map(([name, flags]) => `"${name} "*) allowed="${flags}" ;;`)
	.join("\n")}
esac
if [ -n "$allowed" ]; then
	for arg in "$@"; do
		case "$arg" in
		-[A-Za-z-]*) case " $allowed ${EVERYWHERE} " in
			*" $arg "*) ;;
			*) echo "ERROR: unrecognized arguments: $arg" >&2; exit 2 ;;
			esac ;;
		esac
	done
fi
${[extra.slow ?? []]
	.flat()
	.map((slow) => `case "$*" in *"${slow}"*) /bin/sleep 0.3 ;; esac`)
	.join("\n")}
case "$*" in
${
	extra.failing
		? `*"${extra.failing}"*) ${failed} ;;
esac
case "$*" in
`
		: ""
}*"containerapp show"*"probes[0].type"*) echo "${extra.heldProbe ?? ""}" ;;
*"containerapp show"*"merge("*) while [ $# -gt 0 ]; do
	if [ "$1" = "--query" ]; then
		probes="$(printf '%s' "$2" | sed 's/.*{probes: \`\\(.*\\)\`})].*/\\1/')"
		printf '{"properties":{"template":{"revisionSuffix":null,"containers":[%s]}}}\\n' "$(printf '%s' '${shown}' | sed 's/}$//'),\\"probes\\":$probes}"
	fi
	shift
done ;;
*"containerapp show"*) echo '${shown}' ;;
"rest "*"--method get"*"merge("*) while [ $# -gt 0 ]; do
	if [ "$1" = "--query" ]; then
		probes="$(printf '%s' "$2" | sed 's/.*{probes: \`\\(.*\\)\`})].*/\\1/')"
		printf '{"properties":{"template":{"revisionSuffix":null,"containers":[%s]}}}\\n' "$(printf '%s' '${container}' | sed 's/}$//'),\\"probes\\":$probes}"
	fi
	shift
done ;;
"rest "*"--method get"*) echo '${container}' ;;
"rest "*) while [ $# -gt 0 ]; do
	[ "$1" != "--body" ] || { cat "\${2#@}"; echo; } >> "${bodies}"
	shift
done ;;
*"job start"*) echo "exec-$(wc -l < "${calls}" | tr -d ' ')" ;;
*"job logs show"*) cat "${log}" ;;
*"execution show"*) echo "${status}" ;;
*"network-rule list"*) cat "${rules}" ;;
*"network-rule add"*|*"network-rule remove"*) case "$*" in *"network-rule add"*) adding=1 ;; *) adding="" ;; esac
while [ $# -gt 0 ]; do
	if [ "$1" = "--ip-address" ]; then
		grep -vxF -- "$2" "${rules}" > "${rules}.next" || true
		mv "${rules}.next" "${rules}"
		[ -z "$adding" ] || echo "$2" >> "${rules}"
	fi
	shift
done ;;
*"tag update"*) deleting=""
while [ $# -gt 0 ]; do
	case "$1" in
	--operation) [ "$2" != "Delete" ] || deleting=1 ;;
	--tags) if [ -n "$deleting" ]; then echo > "${tag}"; else echo "\${2#*=}" > "${tag}"; fi ;;
	esac
	shift
done ;;
*"storage account show"*tags.ingestListener*) cat "${access}" "${action}" "${tag}" ;;
*"storage account show"*) cat "${access}" ;;
*"--public-network-access"*) while [ $# -gt 0 ]; do
	[ "$1" != "--public-network-access" ] || echo "$2" > "${access}"
	shift
done ;;
*"blob list"*) cat "${blobs}" ;;
*"upload-batch"*) while [ $# -gt 0 ]; do
	[ "$1" = "--source" ] && (cd "$2" && find . -type f | sed 's|^\\./||' | LC_ALL=C sort) >> "${uploads}"
	shift
done ;;
esac`,
	);
	stub(
		"curl",
		`echo "$*" >> "${lookups}"
${extra.publicIp === null ? "exit 6" : `echo "${extra.publicIp ?? "203.0.113.7"}"`}`,
	);
	for (const [name, body] of Object.entries(extra.bin ?? {})) stub(name, body);
	return {
		env: { PATH: `${bin}:${process.env.PATH}` },
		/** Where the account is kept, for a stand-in that carries on from this one. */
		bin,
		/** The account as the calls left it. */
		state() {
			return {
				publicNetworkAccess: readFileSync(access, "utf8").trim(),
				ipRules: readFileSync(rules, "utf8").split("\n").filter(Boolean),
				defaultAction: readFileSync(action, "utf8").trim(),
				tag: readFileSync(tag, "utf8").trim(),
			};
		},
		read() {
			const all = readFileSync(calls, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean);
			return {
				calls: all.join("\n"),
				all,
				uploaded: readFileSync(uploads, "utf8").split("\n").filter(Boolean),
				bodies: readFileSync(bodies, "utf8")
					.split("\n")
					.filter((line) => line.trim())
					.map((line) => JSON.parse(line) as unknown),
				lookups: readFileSync(lookups, "utf8").split("\n").filter(Boolean),
				job: all
					.filter((line) => /job (update|start)/.test(line))
					.map((line) =>
						line.includes("job start")
							? "start"
							: `update ${line.replace(/^.*-n job /, "").replace(/ -o none$/, "")}`,
					),
				subscribed: all.every((line) =>
					/(^| )--subscription sub( |$)/.test(line),
				),
			};
		},
	};
}
