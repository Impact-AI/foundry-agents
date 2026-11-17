#!/usr/bin/env bash
# The data resources are locked against deletion; `azd down` is the one
# deletion that is meant, so the locks come off first.
# azd runs a posix hook with sh, which on Debian is dash and has no pipefail;
# the hook is bash's, so it hands itself to bash first.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
# az's default subscription is whichever was selected last on this machine; every call names the environment's.
: "${AZURE_SUBSCRIPTION_ID:?predown: AZURE_SUBSCRIPTION_ID is not in the azd environment}"

# The group and the account are the template's outputs, which an environment
# whose provision never completed does not hold. The group's name is the
# template's own (`rg-<environment>`, names.resourceGroup in infra/main.bicep),
# and the accounts are asked of the group, so what a failed provision made
# before it failed is taken down too. A group that does not exist has nothing
# to take down.
group="${AZURE_RESOURCE_GROUP:-}"
if [ -z "$group" ]; then
	: "${AZURE_ENV_NAME:?predown: neither AZURE_RESOURCE_GROUP nor AZURE_ENV_NAME is in the azd environment}"
	group="rg-$AZURE_ENV_NAME"
fi
exists="$(az group exists --subscription "$AZURE_SUBSCRIPTION_ID" -n "$group")"
[ "$exists" = "true" ] || exit 0

locks="$(az lock list --subscription "$AZURE_SUBSCRIPTION_ID" -g "$group" --query "[].id" -o tsv)"
while read -r lock; do
	[ -n "$lock" ] || continue
	az lock delete --subscription "$AZURE_SUBSCRIPTION_ID" --ids "$lock" -o none
done <<<"$locks"

# The Agent Service's capability hosts come off before the account: each
# project's first, then the account's, which is what lets go of an injected
# subnet (Azure finishes releasing it in the background, up to about twenty
# minutes). A group with no account, or whose account is already gone, has
# nothing to take down.
account="${AZURE_OPENAI_RESOURCE_NAME:-}"
if [ -z "$account" ]; then
	accounts="$(az cognitiveservices account list --subscription "$AZURE_SUBSCRIPTION_ID" -g "$group" --query "[?kind=='AIServices'].name" -o tsv)"
	account="$(printf '%s\n' "$accounts" | head -n 1)"
fi
[ -n "$account" ] || exit 0
api=2025-12-01
account_id="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$group/providers/Microsoft.CognitiveServices/accounts/$account"
if ! missing="$(az resource show --subscription "$AZURE_SUBSCRIPTION_ID" --ids "$account_id" --api-version "$api" -o none 2>&1)"; then
	case "$missing" in
	*NotFound*) exit 0 ;;
	*) echo "$missing" >&2 && exit 1 ;;
	esac
fi

# $1 a resource id; prints the ids of its children of type $2, one a line.
children() {
	az rest --subscription "$AZURE_SUBSCRIPTION_ID" --method get --url "https://management.azure.com$1/$2?api-version=$api" --query "value[].id" -o tsv
}

# Each list is assigned before it is walked: a failed substitution in a for
# list would not stop the hook, an assignment does.
projects="$(children "$account_id" projects)"
for project in $projects; do
	hosts="$(children "$project" capabilityHosts)"
	for host in $hosts; do
		az resource delete --subscription "$AZURE_SUBSCRIPTION_ID" --ids "$host" --api-version "$api" -o none
	done
done
hosts="$(children "$account_id" capabilityHosts)"
for host in $hosts; do
	az resource delete --subscription "$AZURE_SUBSCRIPTION_ID" --ids "$host" --api-version "$api" -o none
done
