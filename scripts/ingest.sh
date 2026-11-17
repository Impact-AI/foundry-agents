#!/usr/bin/env bash
# Make a directory of your own documents a library of the knowledge base, or
# take a library out of it:
#
#   ./scripts/ingest.sh [--dry-run] [--open-listener [--ip <address>]] <dir> [name]
#   ./scripts/ingest.sh [--dry-run] [--open-listener [--ip <address>]] --remove <name>
#   ./scripts/ingest.sh --close-leftover
#
# The directory is mirrored to the library container under <name>/ (the
# directory's own name by default), as you with --auth-mode login: every file
# whose bytes its blob does not already hold uploaded, every blob under
# <name>/ the directory no longer has deleted. Then the migrate job loads
# that prefix from inside the network: it describes each file in its blob's
# metadata (readers from access.json, title and tags from front matter or
# catalog.json), runs AI Search's indexer and waits for it, deletes the
# chunks of files that have gone, and has Prompt Shields read every new
# chunk. A file that did not change is not uploaded, so the indexer reads it
# no more, and a file of a format no library takes is named and never sent.
# --remove deletes the prefix and every chunk of the library; --dry-run
# names each file that would be uploaded and each blob that would be
# deleted, and uploads, deletes and loads nothing. With private networking
# on, the account has no public listener and its firewall denies by
# default, so the mirror cannot reach it from outside the network: the
# script refuses, naming the two ways through, unless --open-listener is
# given, which turns the listener on and adds one firewall rule, for this
# machine's public IPv4 address, for the mirror alone, and takes both back
# before the job runs — and on exit, whether the run ends by itself, by an
# error or by a signal bash can act on. A dry run has to list the blobs too,
# so with --open-listener it opens and closes the account the same way. The
# firewall's default stays Deny, so the rule lets in this address and no
# other. The address is the one --ip names, or else the one
# https://api.ipify.org reports to this machine; either must be a public
# one, which is the only kind a storage firewall rule admits.
#
# What the script opened it says on the account itself, in a tag
# (ingestListener: the run, the address, what it opened and when), written
# before it opens anything and taken off once it has closed, so every
# machine sees it. A run that finds the tag touches nothing of another run's:
# while the tag is younger than an hour it refuses, since that run may still
# be uploading; older, it closes what the tag names when the address is this
# machine's own, and otherwise refuses. --close-leftover closes what the tag
# names whatever its age, for a run known to have ended. Closing takes out
# the rule the tag names and turns the listener off only where the firewall
# still denies by default: an account made public since is left public. A
# hidden file or directory (a name starting with a dot) and a symbolic link
# are never sent.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../hooks/job.sh
. "$here/../hooks/job.sh"
# shellcheck source=../hooks/private.sh
. "$here/../hooks/private.sh"

# Asked for this machine's public address only under --open-listener without --ip.
ip_lookup="https://api.ipify.org"
# What stops the script is named, in its own words, as the PowerShell twin names it.
stop() {
	echo "ingest: $1" >&2
	exit 1
}
# Four octets of at most 255.
ipv4_address() {
	local octet
	printf %s "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
	for octet in ${1//./ }; do
		[ "$((10#$octet))" -le 255 ] || return 1
	done
}
# The address as a firewall rule holds it: each octet without leading zeros,
# so one address is one text wherever it is compared, written or asked for.
canonical_address() {
	local a b c d
	IFS=. read -r a b c d <<<"$1"
	echo "$((10#$a)).$((10#$b)).$((10#$c)).$((10#$d))"
}
# An address the internet reaches a machine by. A storage firewall rule
# admits no other kind: not a private network's, not a carrier's shared
# range, not a loopback, link-local, multicast or reserved one.
public_address() {
	local a b
	a="$((10#${1%%.*}))"
	b="${1#*.}"
	b="$((10#${b%%.*}))"
	case "$a" in
	0 | 10 | 127) return 1 ;;
	100) [ "$b" -lt 64 ] || [ "$b" -gt 127 ] || return 1 ;;
	169) [ "$b" -ne 254 ] || return 1 ;;
	172) [ "$b" -lt 16 ] || [ "$b" -gt 31 ] || return 1 ;;
	192) [ "$b" -ne 168 ] || return 1 ;;
	esac
	[ "$a" -lt 224 ]
}
# How long a run's tag is taken for a run still uploading.
leftover_after=3600
usage="usage: $0 [--dry-run] [--open-listener [--ip <address>]] <dir> [name] | [--dry-run] [--open-listener [--ip <address>]] --remove <name> | --close-leftover
  --dry-run        name what would be uploaded and deleted; upload, delete and load nothing
  --open-listener  where the storage account's public listener is off: turn it on and let this
                   machine's public IPv4 address through its firewall for the upload, then take both back;
                   a dry run lists the blobs, so it opens and closes the account too
  --ip <address>   that address, a public one; when not given it is asked of $ip_lookup
  --close-leftover close what an earlier run of this script left open on the account (its tag names it),
                   whatever its age; alone, it does that and nothing else. Without it a run closes a
                   leftover only when it is over an hour old and for this machine's own address"
dry_run="" remove="" open_listener="" ip="" close_leftover=""
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) dry_run=1 ;;
	--remove) remove=1 ;;
	--open-listener) open_listener=1 ;;
	--close-leftover) close_leftover=1 ;;
	--ip)
		[ $# -ge 2 ] && ipv4_address "$2" || { echo "$usage" >&2; exit 2; }
		public_address "$2" ||
			{ echo "ingest: $2 is not a public address, and a storage firewall rule admits no other; pass the IPv4 address the internet sees this machine by" >&2; exit 2; }
		ip="$(canonical_address "$2")"
		shift
		;;
	-*) echo "$usage" >&2; exit 2 ;;
	*) break ;;
	esac
	shift
done
close_only=""
if [ -n "$close_leftover" ] && [ -z "$remove" ] && [ $# -eq 0 ]; then
	# Nothing to load: the leftover is closed and the run ends.
	close_only=1 dir="" name=""
elif [ -n "$remove" ]; then
	[ $# -eq 1 ] || { echo "$usage" >&2; exit 2; }
	dir="" name="$1"
else
	[ $# -ge 1 ] && [ $# -le 2 ] || { echo "$usage" >&2; exit 2; }
	[ -d "$1" ] || { echo "ingest: $1 is not a directory" >&2; exit 2; }
	dir="$(cd "$1" && pwd)"
	name="${2:-$(basename "$dir")}"
fi
[ -n "$close_only" ] || printf %s "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$' ||
	{ echo "ingest: \"$name\" is not a library name (letters, digits, . _ -); pass one as the second argument" >&2; exit 2; }
if [ -z "$remove" ] && [ -z "$close_only" ]; then
	# The files the job takes, by the name upload-batch gives each: a format
	# a library holds, and the two manifests at its root. Anything else is
	# named here and never sent, as the job would skip it unread; a blob of
	# one an earlier run sent is deleted as gone. The formats are the job's
	# (`formatOf` in platform/knowledge/src/library/formats.ts), and
	# ingest.test.ts holds this line to that list.
	formats='pdf|docx|doc|pptx|ppt|xlsx|xls|html|htm|md|txt|csv|png|jpg|jpeg|gif'
	files=""
	# A name starting with a dot is hidden, and nothing under it is read; a
	# symbolic link is not followed, so nothing outside the directory is sent.
	while IFS= read -r rel; do
		if [ -L "$dir/$rel" ]; then
			echo "ingest: skipping $dir/$rel, a symbolic link"
		elif [ "$rel" = access.json ] || [ "$rel" = catalog.json ] ||
			printf '%s\n' "${rel##*/}" | grep -Eiq "^.+\.($formats)$"; then
			files="${files}${files:+$'\n'}$rel"
		else
			echo "ingest: skipping $dir/$rel, not a format a library takes"
		fi
	done < <(cd "$dir" && find . -name '.?*' -prune -o \( -type f -o -type l \) -print | sed 's|^\./||' | LC_ALL=C sort)
	[ -n "$files" ] || { echo "ingest: $dir holds no file a library takes" >&2; exit 2; }
fi

# The azd environment, as azd hands it to a hook.
values="$(cd "$here/.." && azd env get-values)" || stop "could not read the azd environment"
while IFS= read -r line; do
	[ -n "$line" ] || continue
	value="${line#*=}"
	value="${value#\"}"
	export "${line%%=*}=${value%\"}"
done <<<"$values"
for variable in AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP AZURE_STORAGE_ACCOUNT AZURE_STORAGE_LIBRARY_CONTAINER MIGRATE_JOB_NAME; do
	[ -n "${!variable:-}" ] || { echo "ingest: $variable is not in the azd environment; run azd up first" >&2; exit 1; }
done
container="$AZURE_STORAGE_LIBRARY_CONTAINER"

# One exit trap for the three things a run must leave as it found them: the
# job on the deploy's steps, the listener closed and its rule gone, and no
# copy of the operator's files in the temporary directory. Bash keeps one
# EXIT trap, so all three go through it.
account=(--subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_STORAGE_ACCOUNT")
firewall=(--subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" --account-name "$AZURE_STORAGE_ACCOUNT")
store=(--subscription "$AZURE_SUBSCRIPTION_ID" --auth-mode login --account-name "$AZURE_STORAGE_ACCOUNT")
account_id="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/$AZURE_STORAGE_ACCOUNT"
# What is still to take back: the listener to turn off, the rule to take
# out, the address the rule admits, and the tag that says so on the account.
# `unclosed` is set once a close has been given up on, so the exit path does
# not ask three more times.
opened="" ruled="" admitted="" tag="" unclosed="" steps_moved="" staged=""
# The tag on the account: `<run>:<address>:<listener|listener+rule>:<when>`,
# the time in seconds since the epoch. Merge writes this one tag and leaves
# the account's others; Delete takes this one off.
tag_account() {
	az tag update --subscription "$AZURE_SUBSCRIPTION_ID" --resource-id "$account_id" --operation "$1" --tags "ingestListener=$2" -o none
}
# The listener, the firewall's default and the tag, as the account has them now.
read_account() {
	local answer
	answer="$(az storage account show "${account[@]}" --query "[publicNetworkAccess, networkRuleSet.defaultAction, tags.ingestListener || '']" -o tsv)" ||
		stop "could not read $AZURE_STORAGE_ACCOUNT"
	access="$(sed -n 1p <<<"$answer")"
	default_action="$(sed -n 2p <<<"$answer")"
	tagged="$(sed -n 3p <<<"$answer")"
}
# Turns the listener off and takes the rule out again, then takes the tag
# off. Each is asked whatever became of the other, and asked again when the
# service refuses it; what never lands is named, exactly, with the command
# that does it by hand, and fails the run. The tag stays while anything it
# names is still open, so the next run can see it.
close_listener() {
	local attempt
	for attempt in 1 2 3; do
		[ -z "$opened" ] ||
			! az storage account update "${account[@]}" --public-network-access Disabled -o none || opened=""
		[ -z "$ruled" ] ||
			! az storage account network-rule remove "${firewall[@]}" --ip-address "$admitted" -o none || ruled=""
		[ -n "$opened$ruled" ] || break
		[ "$attempt" -eq 3 ] || sleep 5
	done
	if [ -z "$opened$ruled" ]; then
		echo "ingest: $AZURE_STORAGE_ACCOUNT's public listener is off again"
		if [ -n "$tag" ]; then
			if tag_account Delete "$tag"; then
				tag=""
			else
				echo "ingest: could not take the ingestListener tag off $AZURE_STORAGE_ACCOUNT, which is closed; the next run refuses until it is gone. Take it off: az tag update --subscription $AZURE_SUBSCRIPTION_ID --resource-id $account_id --operation Delete --tags ingestListener=$tag" >&2
			fi
		fi
		return 0
	fi
	unclosed=1
	{
		echo
		if [ -n "$opened" ]; then
			echo "ingest: THE PUBLIC LISTENER OF $AZURE_STORAGE_ACCOUNT IS STILL ON. Close it now:"
			echo "  az storage account update --subscription $AZURE_SUBSCRIPTION_ID -g $AZURE_RESOURCE_GROUP -n $AZURE_STORAGE_ACCOUNT --public-network-access Disabled"
		fi
		if [ -n "$ruled" ]; then
			echo "ingest: THE FIREWALL RULE FOR $admitted ON $AZURE_STORAGE_ACCOUNT IS STILL THERE. Remove it now:"
			echo "  az storage account network-rule remove --subscription $AZURE_SUBSCRIPTION_ID -g $AZURE_RESOURCE_GROUP --account-name $AZURE_STORAGE_ACCOUNT --ip-address $admitted"
		fi
	} >&2
	return 1
}
on_exit() {
	# What is taken back is taken back whole: a second signal does not end the close.
	trap '' TERM HUP INT
	[ -z "$staged" ] || rm -rf "$staged"
	[ -z "$steps_moved" ] || point_job --args "${DEPLOY_STEPS[@]}"
	[ -z "$opened$ruled" ] || [ -n "$unclosed" ] || close_listener || exit 1
}
trap on_exit EXIT
# A signal is taken at the edge of a step, as the PowerShell twin takes it:
# with a handler set the shell lets the call in flight finish first, so a
# call that opens the account is never still running when the close is made.
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT

# This machine's public address, into `ip`: the one given, or the one the
# lookup says, or none.
own_address() {
	local found
	[ -z "$ip" ] || return 0
	found="$(curl -fsS --max-time 10 "$ip_lookup" || true)"
	if ipv4_address "$found" && public_address "$found"; then
		ip="$(canonical_address "$found")"
	fi
}

read_account
# A tag on the account is a run that opened it and has not closed it: one
# still uploading, or one that ended before it could close.
if [ -n "$tagged" ]; then
	left_ip="" left_what="" left_at=""
	IFS=: read -r _ left_ip left_what left_at <<<"$tagged"
	by_hand="az tag update --subscription $AZURE_SUBSCRIPTION_ID --resource-id $account_id --operation Delete --tags ingestListener=$tagged"
	if ! ipv4_address "$left_ip" || ! printf %s "$left_at" | grep -Eq '^[0-9]+$' ||
		{ [ "$left_what" != listener ] && [ "$left_what" != listener+rule ]; }; then
		# Not a tag this script writes: it says nothing of what to close.
		[ -n "$close_leftover" ] ||
			stop "$AZURE_STORAGE_ACCOUNT carries a tag ingestListener=$tagged that this script did not write, so it does not say what was opened. Look at the account, then take the tag off ($by_hand), or run with --close-leftover, which takes it off and touches nothing else."
		tag_account Delete "$tagged" || stop "could not take the ingestListener tag off $AZURE_STORAGE_ACCOUNT"
		echo "ingest: took the tag ingestListener=$tagged off $AZURE_STORAGE_ACCOUNT; it was not one this script wrote, so nothing else was touched"
	else
		age="$(($(date +%s) - left_at))"
		minutes="$((age / 60))"
		if [ -z "$close_leftover" ]; then
			[ "$age" -gt "$leftover_after" ] ||
				stop "another run of this script opened $AZURE_STORAGE_ACCOUNT for $left_ip $minutes minute(s) ago and may still be uploading; nothing of it was touched. Run again when it has ended. If it ended without closing, run with --close-leftover."
			own_address
			[ "$ip" = "$left_ip" ] ||
				stop "a run of this script opened $AZURE_STORAGE_ACCOUNT for $left_ip $minutes minute(s) ago and did not close it, and that is not this machine's address, so nothing of it was touched. Run with --close-leftover to close it."
		fi
		tag="$tagged" admitted="$left_ip"
		[ "$left_what" != listener+rule ] || ruled=1
		# An account whose firewall no longer denies by default is public by
		# design since: its listener is not this script's to turn off.
		if [ "$default_action" = "Deny" ]; then
			opened=1
		else
			echo "ingest: $AZURE_STORAGE_ACCOUNT's firewall no longer denies by default, so its listener is left on"
		fi
		echo "ingest: closing what a run from $left_ip left open on $AZURE_STORAGE_ACCOUNT $minutes minute(s) ago${ruled:+: its firewall rule}${opened:+${ruled:+ and} its public listener}"
		close_listener
	fi
	read_account
elif [ -n "$close_only" ]; then
	echo "ingest: $AZURE_STORAGE_ACCOUNT carries no ingestListener tag: no run of this script left it open"
fi
[ -z "$close_only" ] || exit 0

if [ "$access" = "Disabled" ]; then
	again="./scripts/ingest.sh${dry_run:+ --dry-run}${remove:+ --remove}${dir:+ $dir} $name"
	[ -n "$open_listener" ] ||
		refuse_private "Storage" "$AZURE_STORAGE_ACCOUNT.blob.core.windows.net" \
			"$again" "./scripts/ingest.sh --open-listener${dry_run:+ --dry-run}${remove:+ --remove}${dir:+ $dir} $name"
	# The listener alone is not the way in: the account's firewall denies by
	# default. One rule lets this machine's public address through, and the
	# default is left as it is, so the open listener admits nobody else.
	own_address
	[ -n "$ip" ] ||
		stop "$ip_lookup did not say this machine's public IPv4 address; pass it with --ip <address>"
	# A rule the account already holds for the address is its operator's, and stays.
	rules="$(az storage account network-rule list "${firewall[@]}" --query "ipRules[].ipAddressOrRange" -o tsv)" ||
		stop "could not read the firewall rules of $AZURE_STORAGE_ACCOUNT"
	admitted="$ip"
	what=listener+rule
	! printf '%s\n' "$rules" | grep -qxF -- "$ip" || what=listener
	# Tagged before either call, on the account and here: a change that landed
	# behind a failed answer, or before a kill, is still there to be taken back.
	tag="$(openssl rand -hex 4):$ip:$what:$(date +%s)"
	tag_account Merge "$tag" || { tag=""; stop "could not tag $AZURE_STORAGE_ACCOUNT as open, so nothing was opened"; }
	[ "$what" = listener ] || ruled=1
	opened=1
	az storage account update "${account[@]}" --public-network-access Enabled -o none ||
		stop "could not open the listener of $AZURE_STORAGE_ACCOUNT"
	[ -z "$ruled" ] || az storage account network-rule add "${firewall[@]}" --ip-address "$ip" -o none ||
		stop "could not let $ip through the firewall of $AZURE_STORAGE_ACCOUNT"
	echo "ingest: $AZURE_STORAGE_ACCOUNT's public listener is on for the mirror, for $ip alone; it is off again before the job runs, or when this exits"
	# The account answers the change before its data plane follows it. How
	# long a firewall rule takes to apply is known only from the service's
	# behaviour, so the container is asked until it answers, for two minutes
	# at most.
	reachable=""
	for _ in $(seq 1 24); do
		if az storage container show "${store[@]}" -n "$container" -o none 2>/dev/null; then
			reachable=1
			break
		fi
		sleep 5
	done
	[ -n "$reachable" ] ||
		stop "$AZURE_STORAGE_ACCOUNT did not become reachable within two minutes of opening its listener for $ip. If az leaves this machine by another address (a proxy, a split tunnel), name that one with --ip <address>"
fi

# Plain az data-plane calls under your sign-in, rather than `az storage blob
# sync`, which fetches AzCopy on first use. A listing that fails stops the
# script before anything is uploaded or deleted. Each blob comes with the MD5
# the service computed when it was uploaded in one request.
listed="$(az storage blob list "${store[@]}" -c "$container" --prefix "$name/" --num-results "*" --query "[].[name, properties.contentSettings.contentMd5]" -o tsv)" ||
	stop "could not list $container/$name/"
listing="$(sed '/^$/d' <<<"$listed" | LC_ALL=C sort)"
uploaded="$(cut -f1 <<<"$listing" | sed '/^$/d')"
changed=()
if [ -n "$remove" ]; then
	gone="$uploaded"
else
	gone="$(LC_ALL=C comm -23 <(printf '%s\n' "$uploaded") <(sed "s|^|$name/|" <<<"$files") | sed '/^$/d')"
	# A file whose bytes its blob already holds is not sent again: the
	# indexer reads what changed, and an upload is a change to it.
	while IFS= read -r rel; do
		held="$(printf '%s\t%s' "$name/$rel" "$(openssl dgst -md5 -binary "$dir/$rel" | openssl base64 -A)")"
		grep -qxF -- "$held" <<<"$listing" || changed+=("$rel")
	done <<<"$files"
fi

if [ -n "$dry_run" ]; then
	if [ -z "$remove" ]; then
		# Guarded: an empty array is unbound to bash 3's `set -u`.
		[ "${#changed[@]}" -eq 0 ] ||
			for rel in "${changed[@]}"; do echo "ingest: would upload $dir/$rel to $container/$name/$rel"; done
		echo "ingest: would upload ${#changed[@]} changed file(s) from $dir to $container/$name/"
	fi
	[ -z "$gone" ] || sed "s|^|ingest: would delete $container/|" <<<"$gone"
	echo "ingest: dry run — nothing was uploaded or deleted, and the job did not run"
	exit 0
fi

if [ -n "$remove" ]; then
	az storage blob delete-batch "${store[@]}" --source "$container" --pattern "$name/*" --delete-snapshots include -o none ||
		stop "could not delete $container/$name/"
	echo "ingest: $container/$name/ deleted"
else
	if [ "${#changed[@]}" -gt 0 ]; then
		# The changed files alone, at their paths, so one upload sends them.
		staged="$(mktemp -d)"
		for rel in "${changed[@]}"; do
			mkdir -p "$staged/$(dirname "$rel")"
			cp "$dir/$rel" "$staged/$rel"
		done
		az storage blob upload-batch "${store[@]}" \
			--destination "$container" --destination-path "$name" --source "$staged" --overwrite -o none ||
			stop "the upload failed"
		rm -rf "$staged"
		staged=""
		echo "ingest: ${#changed[@]} changed file(s) of $dir uploaded to $container/$name/"
	else
		echo "ingest: $container/$name/ already holds every file of $dir"
	fi
	if [ -n "$gone" ]; then
		while IFS= read -r blob; do
			az storage blob delete "${store[@]}" -c "$container" -n "$blob" --delete-snapshots include -o none ||
				stop "could not delete $container/$blob"
			echo "ingest: deleted $container/$blob, which $dir no longer has"
		done <<<"$gone"
	fi
fi

# The mirror is over: the job reads the account from inside the network.
[ -z "$opened$ruled" ] || close_listener

# The job rests on the deploy's steps; it goes back to them however this ends.
step="library:$name"
[ -z "$remove" ] || step="remove-library:$name"
deploy_steps
steps_moved=1
point_job --args src/job.ts "$step"
run_job "$step"
# Readers the load recorded and nothing enforces are said here, not left in the job's log.
[ -n "$remove" ] || say_unenforced "$step"
