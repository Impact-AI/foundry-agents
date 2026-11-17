#!/usr/bin/env bash
# After azd has deployed: the migrate job takes the backend image azd just
# built (azd rolls the Container Apps, never the job) and runs the deploy's
# steps in one execution, waited for, so a failed step fails the deploy
# rather than the first request: the settings documents, the search index
# and its pipeline, the agent's skills, its memory store (when the agent
# document names it) and its first versions, and the sample library — or,
# when SEED_SAMPLE_LIBRARY is false, the sample library's removal, a no-op
# once it is gone. One execution because each costs a container start, and
# the steps log under their own names.
#
# Before that, each app azd deployed that holds no health probes is given the
# template's (its outputs `*_APP_NAME` and `*_PROBES`), as a new revision. A
# first provision puts the placeholder image on an app, which answers on
# neither probe's port, so the template gives it none, and `azd deploy`
# changes only the image: without this a first `azd up` ends with apps no
# probe watches until the next provision. An app that holds its probes is
# left as it is, so a later deploy changes nothing here.
# azd runs a posix hook with sh, which on Debian is dash and has no pipefail;
# the hook is bash's, so it hands itself to bash first.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=job.sh
. "$here/job.sh"

require_subscription postdeploy
image="${SERVICE_BACKEND_IMAGE_NAME:?azd sets SERVICE_BACKEND_IMAGE_NAME after deploying the backend}"
# The app named, given the probes named (JSON), unless it holds some. The
# container is read whole, at the API version the patch is sent with (az
# containerapp show reads a later one, whose container carries properties
# this version refuses), with the probes merged in, and sent back as a
# merge patch: the one container replaces the list, everything else on the
# app stays. The revision suffix is cleared, since azd's names the revision
# it just made and a second revision cannot take it.
probe() {
	local name="$1" probes="$2" held body
	if [ -z "$name" ] || [ -z "$probes" ]; then
		echo "postdeploy: the azd environment names no app or no probes to give it; azd provision gives the probes" >&2
		return 0
	fi
	held="$(az containerapp show --subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$name" --query "properties.template.containers[0].probes[0].type" -o tsv)" ||
		{ echo "postdeploy: could not read the app $name" >&2; exit 1; }
	if [ -n "$held" ]; then
		return 0
	fi
	body="$(mktemp)" app="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.App/containerApps/$name"
	az rest --subscription "$AZURE_SUBSCRIPTION_ID" --method get --url "$app" --url-parameters api-version=2026-01-01 \
		--query "{properties: {template: {revisionSuffix: \`null\`, containers: [merge(properties.template.containers[0], {probes: \`$probes\`})]}}}" -o json >"$body" ||
		{ rm -f "$body"; echo "postdeploy: could not read the app $name" >&2; exit 1; }
	az rest --subscription "$AZURE_SUBSCRIPTION_ID" --method patch --url "$app" \
		--url-parameters api-version=2026-01-01 --body "@$body" -o none ||
		{ rm -f "$body"; echo "postdeploy: could not give the app $name its health probes" >&2; exit 1; }
	rm -f "$body"
	echo "postdeploy: $name given its health probes"
}
probe "${BACKEND_APP_NAME:-}" "${BACKEND_PROBES:-}"
probe "${FRONTEND_APP_NAME:-}" "${FRONTEND_PROBES:-}"

deploy_steps
point_job --image "$image" --args "${DEPLOY_STEPS[@]}"
run_job "deploy (${DEPLOY_STEPS[*]:1})"
