#!/usr/bin/env bash
# After the template: the sign-in callback on the Entra app registration,
# project connections to a knowledge base's MCP endpoint deleted, since
# nothing uses one, the project's Application Insights connection deleted
# unless AGENT_TRACING asks for it, and, behind Front Door, the edge's private link to the
# Container Apps environment approved. Control-plane and Microsoft Graph calls only; what
# lives inside the data services is written by the migrate job after the
# deploy.
# azd runs a posix hook with sh, which on Debian is dash and has no pipefail;
# the hook is bash's, so it hands itself to bash first.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail

# az's default subscription is whichever was selected last on this machine; every call names the environment's.
: "${AZURE_SUBSCRIPTION_ID:?postprovision: AZURE_SUBSCRIPTION_ID is not in the azd environment}"

# The sign-in callback at the address this provision made, on the Entra app
# registration preprovision made (hooks/entra.sh). Never fails the provision.
bash "$(dirname "$0")/entra.sh" redirect || true

# The backend asks the knowledge base itself, on both channels; a project
# connection to a base's MCP endpoint (category RemoteTool, a target under
# /knowledgebases/) is one nothing uses. Deleted where it is left; never
# fails the provision.
if [ -n "${AZURE_OPENAI_RESOURCE_NAME:-}" ] && [ -n "${FOUNDRY_PROJECT_ENDPOINT:-}" ]; then
	connections="https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.CognitiveServices/accounts/$AZURE_OPENAI_RESOURCE_NAME/projects/${FOUNDRY_PROJECT_ENDPOINT##*/}/connections"
	if names="$(az rest --method get --url "$connections?api-version=2025-10-01-preview" \
		--query "value[?properties.category=='RemoteTool' && contains(properties.target, '/knowledgebases/')].name" -o tsv)"; then
		while read -r name; do
			[ -n "$name" ] || continue
			if az rest --method delete --url "$connections/$name?api-version=2025-10-01-preview" -o none; then
				echo "postprovision: deleted the project connection $name, to a knowledge base's MCP endpoint"
			else
				echo "postprovision: the project connection $name, to a knowledge base's MCP endpoint, could not be deleted; delete it in the portal (Management center, Connected resources)" >&2
			fi
		done <<<"$names"
	else
		echo "postprovision: the project's connections to a knowledge base's MCP endpoint could not be read; delete them in the portal (Management center, Connected resources)" >&2
	fi
	# The project's connection to Application Insights is the switch for the
	# Agent Service's traces of every turn's words (infra/modules/foundry.bicep).
	# The template makes it only with AGENT_TRACING, but an incremental
	# deployment never deletes a resource whose condition turned false, so a
	# deployment that once had it keeps it until it is deleted here. Never
	# fails the provision; left, it is named.
	case "${AGENT_TRACING:-false}" in
	[Tt][Rr][Uu][Ee]) ;;
	*)
		if insights="$(az rest --method get --url "$connections?api-version=2025-10-01-preview" \
			--query "value[?name=='insights' && properties.category=='AppInsights'].name" -o tsv)"; then
			if [ -n "$insights" ]; then
				if az rest --method delete --url "$connections/insights?api-version=2025-10-01-preview" -o none; then
					echo "postprovision: deleted the project connection insights, since AGENT_TRACING is off; the Agent Service no longer traces the project's turns"
				else
					echo "postprovision: the project connection insights could not be deleted, and the Agent Service still traces every turn's words although AGENT_TRACING is off; delete it in the portal (Management center, Connected resources)" >&2
				fi
			fi
		else
			echo "postprovision: the project's connections could not be read to check for insights, which traces every turn's words while it stands; with AGENT_TRACING off, delete it in the portal if it is there (Management center, Connected resources)" >&2
		fi
		;;
	esac
fi

[ -n "${FRONT_DOOR_ENDPOINT:-}" ] || exit 0
# The edge's request alone is approved: Front Door files it with the message
# the template gives its origin (`requestMessage` in infra/modules/edge.bicep),
# which the pending connection carries as its description. Any other pending
# request on the environment is somebody's to decide, and is named.
environment="$(az containerapp env show --subscription "$AZURE_SUBSCRIPTION_ID" -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_CONTAINER_APPS_ENVIRONMENT_NAME" --query id -o tsv)"
pending="$(az network private-endpoint-connection list --subscription "$AZURE_SUBSCRIPTION_ID" --id "$environment" \
	--query "[?properties.privateLinkServiceConnectionState.status=='Pending'].[id, properties.privateLinkServiceConnectionState.description]" -o tsv)"
while IFS=$'\t' read -r connection description; do
	[ -n "$connection" ] || continue
	if [ "$description" = "frontend" ]; then
		az network private-endpoint-connection approve --subscription "$AZURE_SUBSCRIPTION_ID" --id "$connection" --description "front door" -o none
	else
		echo "postprovision: left pending a private link request that is not the edge's (\"$description\"): $connection. If it is yours: az network private-endpoint-connection approve --subscription $AZURE_SUBSCRIPTION_ID --id $connection" >&2
	fi
done <<<"$pending"
