#!/usr/bin/env bash
# The Microsoft Entra app registration Entra sign-in runs on, made for the
# person deploying. Run by preprovision (`register`) and postprovision
# (`redirect`), never on its own, and only when the environment signs in with
# Entra (AUTH_MODE=entra, or HARDENED) and ENTRA_APP_SETUP is not false.
#
# register, while AUTH_MICROSOFT_ENTRA_ID_ID is empty or the vault's
# placeholder: finds the registration named `<env>-sign-in` that the deployer
# owns, or makes it (single tenant, Web), with the app roles `user`, `premium`
# and `tester` and the groups claim; makes its service principal and a client
# secret; sets both values into the azd environment, so the provision that
# follows writes them to Key Vault through the template, as it writes every
# other secret; and assigns the deployer `user` and `tester`. A registration
# found is completed, never duplicated, and keeps its secrets: a new one is
# appended beside them. Where the vault already holds a client id and the
# registration of that name is somebody else's, the deployment has its
# registration and this machine has no copy of its id: nothing is made, since
# a second one would be written over the first in Key Vault, and the ways on
# are said (KEY_VAULT_HOLDS, which preprovision hands over).
#
# redirect, once the provision has made FRONTEND_URL: adds the sign-in
# callback to the registration's redirect URIs when it is missing, on the
# registration this script names and no other.
#
# Microsoft Graph is tenant-wide and `az ad` asks the tenant of az's selected
# subscription, so the script stops unless that is the environment's. A
# pipeline's identity is left alone: the registration is a person's, and a
# pipeline carries its values as variables. Anything refused (Graph answers
# 403 to whoever may not register applications) is reported with the steps
# that do it by hand; the callers never fail the deployment for it.
# azd runs a posix hook with sh, which on Debian is dash and has no pipefail;
# the script is bash's, so it hands itself to bash first.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail

mode="${1:?entra: register or redirect}"
[ "${ENTRA_APP_SETUP:-true}" != "false" ] || exit 0
[ "${HARDENED:-}" = "true" ] || [ "${AUTH_MODE:-}" = "entra" ] || exit 0
: "${AZURE_SUBSCRIPTION_ID:?entra: AZURE_SUBSCRIPTION_ID is not in the azd environment}"
: "${AZURE_ENV_NAME:?entra: AZURE_ENV_NAME is not in the azd environment}"

name="$AZURE_ENV_NAME-sign-in"
app="${AUTH_MICROSOFT_ENTRA_ID_ID:-}"
[ "$app" != "unset" ] || app=""
callback=""
[ -z "${FRONTEND_URL:-}" ] || callback="${FRONTEND_URL%/}/api/auth/callback/microsoft-entra-id"

case "$mode" in
register) [ -z "$app" ] || exit 0 ;;
redirect) [ -n "$app" ] && [ -n "$callback" ] || exit 0 ;;
*) echo "entra: unknown mode $mode" >&2 && exit 1 ;;
esac

# Each answer is assigned before it is compared: a lookup that fails stops
# the script, where a failed substitution inside a test would read as an
# identity that is not a person's, or as two tenants that are the same.
signed_in="$(az account show --subscription "$AZURE_SUBSCRIPTION_ID" --query user.type -o tsv)" ||
	{ echo "entra: az account show --subscription failed" >&2; exit 1; }
if [ "$signed_in" != "user" ]; then
	[ "$mode" = "redirect" ] || echo "entra: a pipeline's identity does not make the sign-in registration; set AUTH_MICROSOFT_ENTRA_ID_ID and AUTH_MICROSOFT_ENTRA_ID_SECRET (docs/deployment.md, \"Sign-in with Microsoft Entra ID\")" >&2
	exit 0
fi

work="$(mktemp -d)"
# Set once the registration's values are in the environment: what is left then is the deployer's roles.
stage=""
manual() {
	cat >&2 <<EOF
entra: the sign-in app registration was not finished, and the deployment carries
on without it: Entra sign-in fails for whoever it lacks. Make it by hand
(docs/deployment.md, "Sign-in with Microsoft Entra ID"), or ask whoever may
register applications in this tenant; ENTRA_APP_SETUP=false stops this attempt.
EOF
	if [ "$mode" = "redirect" ]; then
		echo "  add the redirect URI $callback to the registration" >&2
	elif [ -n "$stage" ]; then
		echo "  assign yourself the roles user and tester: Enterprise applications -> $name -> Users and groups" >&2
	else
		cat >&2 <<EOF
  az ad app create --display-name $name --sign-in-audience AzureADMyOrg --app-roles @approles.json${callback:+ --web-redirect-uris $callback}
  az ad app update --id <appId> --set groupMembershipClaims=ApplicationGroup
  az ad sp create --id <appId>
  azd env set AUTH_MICROSOFT_ENTRA_ID_ID <appId>
  azd env set AUTH_MICROSOFT_ENTRA_ID_SECRET "\$(az ad app credential reset --id <appId> --append --query password -o tsv)"
  azd provision
EOF
	fi
}
finish() {
	status=$?
	rm -rf "$work"
	[ "$status" -eq 0 ] || manual
}
trap finish EXIT

selected_tenant="$(az account show --query tenantId -o tsv)" ||
	{ echo "entra: az account show --query failed" >&2; exit 1; }
own_tenant="$(az account show --subscription "$AZURE_SUBSCRIPTION_ID" --query tenantId -o tsv)" ||
	{ echo "entra: az account show --subscription failed" >&2; exit 1; }
if [ "$selected_tenant" != "$own_tenant" ]; then
	# shellcheck disable=SC2016 # the command is printed for the reader to run
	echo 'entra: az'"'"'s selected subscription is in another tenant than the environment'"'"'s: az account set --subscription "$(azd env get-value AZURE_SUBSCRIPTION_ID)", then azd provision' >&2
	exit 1
fi

# Graph makes a new object visible to the next call within seconds, not at once.
retry() {
	for _ in 1 2 3 4 5 6; do
		"$@" && return 0
		sleep 5
	done
	"$@"
}

# The sign-in callback among the registration's redirect URIs.
ensure_redirect() {
	[ -n "$callback" ] || return 0
	local uris
	uris="$(az ad app show --id "$app" --query "web.redirectUris" -o tsv)"
	if ! printf '%s\n' "$uris" | grep -qxF "$callback"; then
		# shellcheck disable=SC2086 # one URI a line, none with a space
		az ad app update --id "$app" --web-redirect-uris $uris "$callback" -o none
	fi
}

if [ "$mode" = "redirect" ]; then
	# A registration somebody else made and named is theirs to change. The
	# name is assigned before it is compared: a lookup that fails stops the
	# script, where a failed substitution inside a test would read as a
	# registration under another name.
	shown="$(az ad app show --id "$app" --query displayName -o tsv)"
	[ "$shown" = "$name" ] || exit 0
	ensure_redirect
	exit 0
fi

# Each role: value, display name, description, and a fixed id (an app role's
# id is unique within its registration, so a constant is enough).
roles="user|User|May sign in|ca02a6f3-6ffc-4b88-aad4-8f0cced532d6
premium|Premium|The premium tier|acb772d5-d73d-4432-86af-50b61225fa90
tester|Tester|Tunes live voice for their own sessions|1b06d81d-62e8-4a52-a6da-a32ea2d41d49"
# Prints the roles not among $1's values (one a line) as JSON objects, one a line.
missing_roles() {
	printf '%s\n' "$roles" | while IFS='|' read -r value title description id; do
		printf '%s\n' "$1" | grep -qx "$value" ||
			printf '{"allowedMemberTypes":["User"],"description":"%s","displayName":"%s","id":"%s","isEnabled":true,"value":"%s"}\n' \
				"$description" "$title" "$id" "$value"
	done
}

deployer="$(az ad signed-in-user show --query id -o tsv)"
found="$(az ad app list --filter "displayName eq '$name'" --query "[].appId" -o tsv)"
for candidate in $found; do
	# Assigned first, for the same reason: owners that cannot be read are not
	# "somebody else's registration", which would make a second one.
	owned="$(az ad app owner list --id "$candidate" --query "[?id=='$deployer'].id" -o tsv)"
	if [ -n "$owned" ]; then
		app="$candidate"
		break
	fi
done

# A registration of this name that somebody else owns, in an environment
# whose vault already holds a client id: whoever provisioned first made the
# deployment its registration, and the people who sign in are assigned on it.
# One made here would replace it in Key Vault at this provision and lock them
# all out, so nothing is made.
if [ -z "$app" ] && [ -n "$found" ] &&
	printf '%s\n' "${KEY_VAULT_HOLDS:-}" | tr ',' '\n' | grep -qx entra-client-id; then
	others="$(printf '%s\n' "$found" | paste -sd' ' -)"
	cat >&2 <<EOF
entra: a registration named $name exists that you do not own ($others),
and the vault already holds a client id: this deployment has its sign-in
registration. Another would replace it in Key Vault and lock out everyone
assigned on it, so nothing was made. One of:
  azd env set AUTH_MICROSOFT_ENTRA_ID_ID <appId>, then provision: the vault keeps the secret it holds
  have its owner add you as an owner, then provision: the registration is completed, not duplicated
  azd env set ENTRA_APP_SETUP false, to leave the registration to whoever owns it
  if it is another deployment's of the same name, make this one's by hand (docs/deployment.md, "Sign-in with Microsoft Entra ID")
EOF
	exit 0
fi

if [ -z "$app" ]; then
	printf '[%s]' "$(missing_roles "" | paste -sd, -)" >"$work/roles.json"
	app="$(az ad app create --display-name "$name" --sign-in-audience AzureADMyOrg \
		--app-roles "@$work/roles.json" ${callback:+--web-redirect-uris "$callback"} --query appId -o tsv)"
	echo "entra: made the app registration $name" >&2
else
	echo "entra: completing the app registration $name" >&2
	added="$(missing_roles "$(az ad app show --id "$app" --query "appRoles[].value" -o tsv)" | paste -sd, -)"
	if [ -n "$added" ]; then
		existing="$(az ad app show --id "$app" --query appRoles -o json)"
		separator=""
		case "$existing" in *"{"*) separator="," ;; esac
		printf '%s%s%s]' "${existing%]*}" "$separator" "$added" >"$work/roles.json"
		az ad app update --id "$app" --app-roles "@$work/roles.json" -o none
	fi
	ensure_redirect
fi
az ad app update --id "$app" --set groupMembershipClaims=ApplicationGroup -o none
principal="$(az ad sp show --id "$app" --query id -o tsv 2>/dev/null || true)"
[ -n "$principal" ] || principal="$(retry az ad sp create --id "$app" --query id -o tsv)"

secret="$(az ad app credential reset --id "$app" --append --display-name azd --query password -o tsv)"
# The secret before the id: an environment that holds the id is taken as
# registered and never asked again, so the id goes in last, once the secret
# it needs is beside it.
azd env set AUTH_MICROSOFT_ENTRA_ID_SECRET "$secret"
azd env set AUTH_MICROSOFT_ENTRA_ID_ID "$app"
stage="assign"

# The deployer may sign in and tune voice. Assigning is the registration
# owner's right, which the deployer is; a refusal here leaves sign-in working
# for whoever is assigned by hand.
assigned="$(retry az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principal/appRoleAssignedTo" \
	--query "value[?principalId=='$deployer'].appRoleId" -o tsv)"
for value in user tester; do
	role="$(az ad app show --id "$app" --query "appRoles[?value=='$value'].id" -o tsv)"
	printf '%s\n' "$assigned" | grep -qx "$role" && continue
	retry az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$principal/appRoleAssignedTo" \
		--headers "Content-Type=application/json" \
		--body "{\"principalId\":\"$deployer\",\"resourceId\":\"$principal\",\"appRoleId\":\"$role\"}" -o none
done
