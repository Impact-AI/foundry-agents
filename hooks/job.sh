#!/usr/bin/env bash
# Sourced by postdeploy and the ingest script: the migrate job, which runs the
# backend image beside the apps, in their network, as its own identity, so
# every write into a data plane happens there and a deployer needs only az.
#
#   require_subscription <who>  fails, with a line from <who>, unless the
#                               environment names its subscription
#   deploy_steps          sets DEPLOY_STEPS: the job's arguments for a deploy,
#                         which are also what it rests on (as the template sets them)
#   point_job <flag>...   az containerapp job update with these flags; `--args`
#                         keeps the job's environment and identity, where
#                         `job start --args` would replace the container with it
#   run_job <label>       start one execution, wait for it, print its log's last
#                         200 lines if it failed (az's own default is the last
#                         ~20, which hides a failure early in a long execution);
#                         returns non-zero unless it succeeded. A status that
#                         cannot be read is asked again; five in a row end the
#                         wait, naming the execution, which may still be running.
#                         The execution's name is left in JOB_EXECUTION
#   say_unenforced <label>  after a library load that succeeded: the lines of
#                         the execution's log that say readers are recorded and
#                         not enforced (access.enforceAccessControl off),
#                         repeated on stderr where the operator sees them. A
#                         log that cannot be read says nothing; the load stands
#
# Every az call names the environment's subscription: az's default is
# whichever one was selected last on this machine, and a job looked for
# there "does not exist".

require_subscription() {
	[ -n "${AZURE_SUBSCRIPTION_ID:-}" ] ||
		{ echo "$1: AZURE_SUBSCRIPTION_ID is not in the azd environment; run azd up first" >&2; exit 1; }
}

deploy_steps() {
	local sample=library
	if [ "$(printf %s "${SEED_SAMPLE_LIBRARY:-true}" | tr '[:upper:]' '[:lower:]')" = "false" ]; then
		sample=remove-library
	fi
	# shellcheck disable=SC2034 # read by the scripts that source this file
	DEPLOY_STEPS=(src/job.ts settings index skills agent "$sample")
}

point_job() {
	az containerapp job update --subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$MIGRATE_JOB_NAME" "$@" -o none
}

run_job() {
	local execution status unread=0
	execution="$(az containerapp job start --subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$MIGRATE_JOB_NAME" --query name -o tsv)"
	JOB_EXECUTION="$execution"
	echo "$1: started $execution"
	for _ in $(seq 1 180); do
		if status="$(az containerapp job execution show --subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$MIGRATE_JOB_NAME" --job-execution-name "$execution" --query properties.status -o tsv)"; then
			unread=0
		else
			unread=$((unread + 1))
			if [ "$unread" -ge 5 ]; then
				echo "$1: the status of $execution could not be read five times in a row; it may still be running" >&2
				return 1
			fi
		fi
		case "$status" in
		Succeeded)
			echo "$1: $execution succeeded"
			return 0
			;;
		Failed | Stopped | Degraded)
			echo "$1: $execution ended $status" >&2
			az containerapp job logs show --subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$MIGRATE_JOB_NAME" --execution "$execution" --container migrate --tail 200 || true
			return 1
			;;
		esac
		sleep 10
	done
	echo "$1: $execution still running after thirty minutes" >&2
	return 1
}

# The job's own words: platform/knowledge's UNENFORCED_READERS, which ingest.test.ts holds this to.
unenforced_mark="WARNING: READERS NOT ENFORCED"
say_unenforced() {
	local log said
	log="$(az containerapp job logs show --subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$MIGRATE_JOB_NAME" --execution "$JOB_EXECUTION" --container migrate --tail 200 2>/dev/null)" || return 0
	said="$(grep -F -- "$unenforced_mark" <<<"$log" || true)"
	[ -n "$said" ] || return 0
	{
		echo
		echo "$1: $unenforced_mark. The library names readers and access control is off, so every signed-in person can find and read all of it until access.enforceAccessControl is on (docs/documents.md, \"Who may read a document\"). The job said:"
		printf '%s\n' "$said"
		echo
	} >&2
}
