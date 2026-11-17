#!/usr/bin/env bash
# Before the template runs: which secrets the vault already holds and which
# services already run, so the template replaces neither with a placeholder;
# the session secret it writes into Key Vault, generated once, when neither
# the azd environment nor the vault has one (azure.yaml's pipeline.secrets
# carries it to CI); the resource providers the template needs; and whether
# the signed-in principal is a person or a pipeline, which its role
# assignments are typed with; and, for Entra sign-in, the app registration.
# azd runs a posix hook with sh, which on Debian is dash and has no pipefail;
# the hook is bash's, so it hands itself to bash first.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail

# The components chosen at deploy time (docs/deployment.md, "Choose components
# at deploy time"), refused before anything is made when a value is unknown or
# a pair cannot work. The same rules and words as RULES in
# apps/backend/src/components.ts, which hooks/preprovision.test.ts runs through
# this block; the migrate job applies them again, to the stored documents too,
# from inside the network this hook cannot reach.
private_networking="${PRIVATE_NETWORKING:-}"
[ -n "$private_networking" ] || private_networking="${HARDENED:-false}"
refused=""
refuse() { refused="${refused}preprovision: $1"$'\n'; }
check_component() {
	local name="$1" value="${!1:-}"
	shift
	[ -n "$value" ] || return 0
	for allowed in "$@"; do [ "$value" = "$allowed" ] && return 0; done
	refuse "components.unknown_value: $name is $value, which is not one of $(printf '%s, ' "$@" | sed 's/, $//'). Set it to one of them, or unset it for the default."
}
check_component MEMORY_STORE foundry own
check_component HISTORY_STORE own foundry
check_component VOICE_ENGINE cascade speechToSpeech
check_component RETRIEVAL_ENGINE hybrid knowledgeBase
if [ "$private_networking" = "true" ] && [ "${MEMORY_STORE:-}" = "foundry" ]; then
	refuse "agent.memory.store_unreachable_private: memory.store is foundry on a private deployment (PRIVATE_NETWORKING), where the Foundry memory store extraction calls the account from public Microsoft addresses and is refused 403; Microsoft documents that VNet integration is not supported for memory stores. Set MEMORY_STORE=own (azd env set MEMORY_STORE own), and memory.store to own in the app/agent document if it exists."
fi
# Zones go with the network. The template would make a zone-redundant
# Container Apps environment with no subnet, which the platform refuses after
# the data services exist, Cosmos DB among them in a mode it cannot leave.
zone_redundant="${ZONE_REDUNDANT:-}"
[ -n "$zone_redundant" ] || zone_redundant="${HARDENED:-false}"
if [ "$zone_redundant" = "true" ] && [ "$private_networking" != "true" ]; then
	refuse "deployment.zones_need_network: ZONE_REDUNDANT is on (set, or through HARDENED) without PRIVATE_NETWORKING. A zone-redundant Container Apps environment needs a virtual network with an infrastructure subnet, which only private networking makes, and Cosmos DB takes zone redundancy once, when its account is created. Set ZONE_REDUNDANT=false (azd env set ZONE_REDUNDANT false), or PRIVATE_NETWORKING=true."
fi
if [ -n "$refused" ]; then
	printf '%s' "$refused" >&2
	exit 1
fi

# az's default subscription is whichever was selected last on this machine; every call names the environment's.
: "${AZURE_SUBSCRIPTION_ID:?preprovision: AZURE_SUBSCRIPTION_ID is not in the azd environment}"

# What the resource group already holds, asked of Azure Resource Manager,
# which answers for a resource whose own listener is closed. A group that
# does not exist yet holds nothing. What exists and cannot be asked stops the
# provision: it would otherwise replace what it could not see.
group="${AZURE_RESOURCE_GROUP:-rg-${AZURE_ENV_NAME:-}}"
held=""
running=""
# What stops the hook is named, in its own words, as the PowerShell twin names it.
stop() {
	echo "preprovision: $1" >&2
	exit 1
}
set_value() { azd env set "$1" "$2" || stop "could not set $1 in the azd environment"; }
group_exists="$(az group exists --subscription "$AZURE_SUBSCRIPTION_ID" -n "$group")" ||
	stop "could not ask whether the resource group $group exists"
if [ "$group_exists" = "true" ]; then
	# The secrets the vault holds. The template writes a placeholder for a
	# secret with no value only while the vault does not hold it, so a
	# provision whose environment carries no value for one (a pipeline's
	# runner, a second machine) leaves a working secret as it is. The answer
	# comes a page at a time, each naming the next.
	vault="$(az resource list --subscription "$AZURE_SUBSCRIPTION_ID" -g "$group" --resource-type Microsoft.KeyVault/vaults --query "[0].name" -o tsv)" ||
		stop "could not list the vaults of the resource group $group"
	if [ -n "$vault" ]; then
		names=""
		secrets="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$group/providers/Microsoft.KeyVault/vaults/$vault/secrets"
		# A later page is asked for by the token the page before it gave, as a
		# parameter of its own: the address a page names carries an ampersand,
		# which a Windows command line splits a command at, so neither twin
		# hands that address on. That the token travels as `$skiptoken` is
		# known only from the service's behaviour.
		token="" more=1
		while [ -n "$more" ]; do
			page=(--url-parameters api-version=2023-07-01)
			[ -z "$token" ] || page+=("\$skiptoken=$token")
			# The first line is the next page's address, empty on the last; the rest are names.
			answer="$(az rest --method get --url "$secrets" "${page[@]}" --query "[nextLink || '', value[].name][]" -o tsv)" ||
				stop "could not ask which secrets the vault $vault holds, and a provision that does not know would replace them with placeholders. Sign az in to an identity that can read the resource group $group, then provision again."
			next="$(printf '%s\n' "$answer" | head -n 1)"
			names="$names"$'\n'"$(printf '%s\n' "$answer" | tail -n +2)"
			[ -n "$next" ] || break
			encoded="$(printf '%s\n' "$next" | sed -nE 's/.*[?&](\$|%24)[Ss][Kk][Ii][Pp][Tt][Oo][Kk][Ee][Nn]=([^&]*).*/\2/p')"
			[ -n "$encoded" ] ||
				stop "the list of the vault $vault's secrets names a next page with no token to ask for it by, so what it holds is not known. Provision again."
			following="$(printf '%b' "${encoded//%/\\x}")"
			[ "$following" != "$token" ] ||
				stop "the list of the vault $vault's secrets names the page just read as the next one, so what it holds is not known. Provision again."
			token="$following"
		done
		held="$(printf '%s\n' "$names" | grep -v '^$' | paste -sd, - || true)"
	fi
	# The services whose container app exists, by the tag azd finds them by.
	# With no image named, the template keeps the image such an app runs, and
	# asks azd whether it exists; this is the same answer from the resource
	# group itself, so a lookup of azd's that failed does not put the
	# placeholder over a running app. Every app's tags are asked for whole and
	# the one tag read here: a query that names it needs a quoted key, and a
	# Windows command line takes the quotes out of an argument.
	tags="$(az resource list --subscription "$AZURE_SUBSCRIPTION_ID" -g "$group" --resource-type Microsoft.App/containerApps --query "[].tags" -o json)" ||
		stop "could not ask which container apps the resource group $group holds, and a provision that does not know could replace a running app's image with the placeholder. Sign az in to an identity that can read the resource group, then provision again."
	running="$(printf '%s\n' "$tags" | grep -o '"azd-service-name": *"[^"]*"' | sed 's/.*: *"\(.*\)"/\1/' | grep -x -e backend -e frontend | sort -u | paste -sd, - || true)"
fi
# Never an empty value: `none` names nothing, and an empty argument is not
# one every shell hands on.
set_value KEY_VAULT_HOLDS "${held:-none}"
set_value SERVICES_RUNNING "${running:-none}"

# The session secret, made once: when the environment carries none and the
# vault holds none either. A machine whose environment has no copy of a
# secret the vault holds makes no new one, which would sign everybody out and
# reach the two apps at different times; the template then leaves the vault's
# alone. azd hands every hook its environment as variables; `azd env
# get-value` is not used because a missing key prints its error on stdout.
if [ -z "${AUTH_SECRET:-}" ] && ! printf '%s\n' "$held" | tr ',' '\n' | grep -qx auth-secret; then
	# Assigned first: a generator that is missing must stop the hook here, in
	# its own words, before an empty value is kept as if it were one.
	generated="$(openssl rand -hex 32)" && [ -n "$generated" ] ||
		stop "could not make the session secret: openssl is not on PATH. Install it, or set one yourself with: azd env set AUTH_SECRET <64 hex characters>"
	set_value AUTH_SECRET "$generated"
fi

# The Agent Service injected into a subnet runs on Container Apps and AKS, and
# an account injected before both providers are registered is left Failed.
# Registering is idempotent and free, so it happens whether or not this
# environment injects.
for namespace in Microsoft.App Microsoft.ContainerService; do
	if [ "$(az provider show --subscription "$AZURE_SUBSCRIPTION_ID" -n "$namespace" --query registrationState -o tsv)" != "Registered" ]; then
		az provider register --subscription "$AZURE_SUBSCRIPTION_ID" -n "$namespace" --wait -o none ||
			stop "could not register the resource provider $namespace"
	fi
done

# The realtime model the voice agent's default speech-to-speech engine runs on
# (`realtime` in the parameter file's models) is offered in few regions, and a
# region that does not offer it fails the provision late, beside everything
# else it made. Said here instead, before anything is made, from what the
# region offers this subscription. Without the deployment, live voice runs as
# a cascade on the chat deployment, so taking it out of the parameter file is
# the way to deploy to such a region. A region az cannot be asked about is
# reported and not refused: the provision decides.
parameters="$(dirname "$0")/../infra/main.parameters.json"
realtime="$(sed -n '/"realtime": *{/,/}/p' "$parameters")"
realtime_field() { printf '%s\n' "$realtime" | sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -n 1; }
if [ -n "$realtime" ] && [ -n "${AZURE_LOCATION:-}" ]; then
	model="$(realtime_field model)"
	version="$(realtime_field version)"
	sku="$(realtime_field sku)"
	if offered="$(az cognitiveservices model list --subscription "$AZURE_SUBSCRIPTION_ID" -l "$AZURE_LOCATION" \
		--query "[?model.name=='$model' && model.version=='$version'].model.skus[].name" -o tsv)"; then
		if ! printf '%s\n' "$offered" | grep -qx "$sku"; then
			cat >&2 <<EOF
preprovision: $AZURE_LOCATION does not offer $model $version as $sku, the realtime
model the voice agent's speech-to-speech engine runs on (models.realtime in
infra/main.parameters.json). Either:

  * deploy to a region that offers it, on an environment that has made nothing yet
    (docs/configuration.md, "The realtime deployment", names them):
      azd env set AZURE_LOCATION <region>

  * or take "realtime" out of models in infra/main.parameters.json: live voice then
    runs as a cascade on the chat deployment.
EOF
			exit 1
		fi
	else
		echo "preprovision: could not ask $AZURE_LOCATION whether it offers $model $version as $sku; the provision will say" >&2
	fi
fi

# Azure refuses a Linux VM with neither a password nor a key, and the jump VM
# is signed in to with Entra ID alone: a key it holds, whose private half is
# deleted here unseen.
if [ "${DEVELOPER_ACCESS:-}" = "true" ] && [ -z "${DEVELOPER_ACCESS_SSH_KEY:-}" ]; then
	keys="$(mktemp -d)"
	ssh-keygen -q -t ed25519 -N '' -C jump-host -f "$keys/key" ||
		{ rm -rf "$keys"; stop "ssh-keygen could not make the jump VM its key"; }
	key="$(cat "$keys/key.pub")"
	rm -rf "$keys"
	set_value DEVELOPER_ACCESS_SSH_KEY "$key"
fi

if [ "$(az account show --subscription "$AZURE_SUBSCRIPTION_ID" --query user.type -o tsv)" = "user" ]; then
	set_value AZURE_PRINCIPAL_TYPE User
else
	set_value AZURE_PRINCIPAL_TYPE ServicePrincipal
fi

# Entra sign-in's app registration, made for the deployer while the
# environment has none, so this provision writes its values to Key Vault
# (hooks/entra.sh). Never fails the provision: what it could not do, it says.
KEY_VAULT_HOLDS="${held:-none}" bash "$(dirname "$0")/entra.sh" register || true
