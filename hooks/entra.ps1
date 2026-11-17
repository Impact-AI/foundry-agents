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
# appended beside them.
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
param([Parameter(Mandatory)][ValidateSet('register', 'redirect')][string]$Mode)
$ErrorActionPreference = 'Stop'
# What stops the script before its own report is said as bash says it: the line alone, on stderr, and exit 1.
trap { [Console]::Error.WriteLine("$_"); exit 1 }

if ($env:ENTRA_APP_SETUP -eq 'false') { exit 0 }
if ($env:HARDENED -ne 'true' -and $env:AUTH_MODE -ne 'entra') { exit 0 }
if (-not $env:AZURE_SUBSCRIPTION_ID) { throw 'entra: AZURE_SUBSCRIPTION_ID is not in the azd environment' }
if (-not $env:AZURE_ENV_NAME) { throw 'entra: AZURE_ENV_NAME is not in the azd environment' }

$name = "$($env:AZURE_ENV_NAME)-sign-in"
$app = if ($env:AUTH_MICROSOFT_ENTRA_ID_ID -and $env:AUTH_MICROSOFT_ENTRA_ID_ID -ne 'unset') { $env:AUTH_MICROSOFT_ENTRA_ID_ID } else { '' }
$callback = if ($env:FRONTEND_URL) { "$($env:FRONTEND_URL.TrimEnd('/'))/api/auth/callback/microsoft-entra-id" } else { '' }

if ($Mode -eq 'register' -and $app) { exit 0 }
if ($Mode -eq 'redirect' -and -not ($app -and $callback)) { exit 0 }

# az's answer, or a throw when it fails: a native command's exit code is not an error to PowerShell.
function Invoke-Az {
	$output = az @args
	if ($LASTEXITCODE -ne 0) { throw "entra: az $($args[0..2] -join ' ') failed" }
	$output
}
# Graph makes a new object visible to the next call within seconds, not at once.
function Invoke-AzRetry {
	for ($attempt = 1; ; $attempt++) {
		try { return Invoke-Az @args } catch { if ($attempt -ge 7) { throw } }
		Start-Sleep -Seconds 5
	}
}

if ((Invoke-Az account show --subscription $env:AZURE_SUBSCRIPTION_ID --query user.type -o tsv) -ne 'user') {
	if ($Mode -eq 'register') { Write-Warning 'entra: a pipeline''s identity does not make the sign-in registration; set AUTH_MICROSOFT_ENTRA_ID_ID and AUTH_MICROSOFT_ENTRA_ID_SECRET (docs/deployment.md, "Sign-in with Microsoft Entra ID")' }
	exit 0
}

$work = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
# Set once the registration's values are in the environment: what is left then is the deployer's roles.
$stage = ''
try {
	if ((Invoke-Az account show --query tenantId -o tsv) -ne (Invoke-Az account show --subscription $env:AZURE_SUBSCRIPTION_ID --query tenantId -o tsv)) {
		throw 'entra: az''s selected subscription is in another tenant than the environment''s: az account set --subscription "$(azd env get-value AZURE_SUBSCRIPTION_ID)", then azd provision'
	}

	# The sign-in callback among the registration's redirect URIs.
	function Set-Redirect {
		if (-not $callback) { return }
		$uris = @(Invoke-Az ad app show --id $app --query web.redirectUris -o tsv | Where-Object { $_ })
		if ($uris -notcontains $callback) {
			Invoke-Az ad app update --id $app --web-redirect-uris @uris $callback -o none
		}
	}

	if ($Mode -eq 'redirect') {
		# A registration somebody else made and named is theirs to change.
		if ((Invoke-Az ad app show --id $app --query displayName -o tsv) -eq $name) { Set-Redirect }
		exit 0
	}

	# Each role, with a fixed id (an app role's id is unique within its registration, so a constant is enough).
	$roles = @(
		[ordered]@{ allowedMemberTypes = @('User'); description = 'May sign in'; displayName = 'User'; id = 'ca02a6f3-6ffc-4b88-aad4-8f0cced532d6'; isEnabled = $true; value = 'user' }
		[ordered]@{ allowedMemberTypes = @('User'); description = 'The premium tier'; displayName = 'Premium'; id = 'acb772d5-d73d-4432-86af-50b61225fa90'; isEnabled = $true; value = 'premium' }
		[ordered]@{ allowedMemberTypes = @('User'); description = 'Tunes live voice for their own sessions'; displayName = 'Tester'; id = '1b06d81d-62e8-4a52-a6da-a32ea2d41d49'; isEnabled = $true; value = 'tester' }
	)
	$rolesFile = Join-Path $work 'roles.json'

	$deployer = Invoke-Az ad signed-in-user show --query id -o tsv
	$found = @(Invoke-Az ad app list --filter "displayName eq '$name'" --query '[].appId' -o tsv | Where-Object { $_ })
	foreach ($candidate in $found) {
		if (Invoke-Az ad app owner list --id $candidate --query "[?id=='$deployer'].id" -o tsv) { $app = $candidate; break }
	}

	# A registration of this name that somebody else owns, in an environment
	# whose vault already holds a client id: whoever provisioned first made the
	# deployment its registration, and the people who sign in are assigned on it.
	# One made here would replace it in Key Vault at this provision and lock them
	# all out, so nothing is made.
	if (-not $app -and $found -and (@("$($env:KEY_VAULT_HOLDS)" -split ',') -ccontains 'entra-client-id')) {
		Write-Warning @"
entra: a registration named $name exists that you do not own ($($found -join ' ')),
and the vault already holds a client id: this deployment has its sign-in
registration. Another would replace it in Key Vault and lock out everyone
assigned on it, so nothing was made. One of:
  azd env set AUTH_MICROSOFT_ENTRA_ID_ID <appId>, then provision: the vault keeps the secret it holds
  have its owner add you as an owner, then provision: the registration is completed, not duplicated
  azd env set ENTRA_APP_SETUP false, to leave the registration to whoever owns it
  if it is another deployment's of the same name, make this one's by hand (docs/deployment.md, "Sign-in with Microsoft Entra ID")
"@
		exit 0
	}

	if (-not $app) {
		ConvertTo-Json -InputObject $roles -Depth 4 | Set-Content -Path $rolesFile
		$create = @('ad', 'app', 'create', '--display-name', $name, '--sign-in-audience', 'AzureADMyOrg', '--app-roles', "@$rolesFile")
		if ($callback) { $create += @('--web-redirect-uris', $callback) }
		$app = Invoke-Az @create --query appId -o tsv
		Write-Host "entra: made the app registration $name"
	} else {
		Write-Host "entra: completing the app registration $name"
		$existing = @(Invoke-Az ad app show --id $app --query appRoles -o json | ConvertFrom-Json)
		$added = @($roles | Where-Object { @($existing.value) -notcontains $_.value })
		if ($added) {
			ConvertTo-Json -InputObject @($existing + $added) -Depth 4 | Set-Content -Path $rolesFile
			Invoke-Az ad app update --id $app --app-roles "@$rolesFile" -o none
		}
		Set-Redirect
	}
	Invoke-Az ad app update --id $app --set groupMembershipClaims=ApplicationGroup -o none
	$principal = az ad sp show --id $app --query id -o tsv 2>$null
	if ($LASTEXITCODE -ne 0 -or -not $principal) { $principal = Invoke-AzRetry ad sp create --id $app --query id -o tsv }

	$secret = Invoke-Az ad app credential reset --id $app --append --display-name azd --query password -o tsv
	# The secret before the id: an environment that holds the id is taken as
	# registered and never asked again, so the id goes in last, once the secret
	# it needs is beside it.
	azd env set AUTH_MICROSOFT_ENTRA_ID_SECRET $secret
	if ($LASTEXITCODE -ne 0) { throw 'entra: could not set AUTH_MICROSOFT_ENTRA_ID_SECRET in the azd environment' }
	azd env set AUTH_MICROSOFT_ENTRA_ID_ID $app
	if ($LASTEXITCODE -ne 0) { throw 'entra: could not set AUTH_MICROSOFT_ENTRA_ID_ID in the azd environment' }
	$stage = 'assign'

	# The deployer may sign in and tune voice. Assigning is the registration
	# owner's right, which the deployer is; a refusal here leaves sign-in working
	# for whoever is assigned by hand.
	$assignments = "https://graph.microsoft.com/v1.0/servicePrincipals/$principal/appRoleAssignedTo"
	$assigned = @(Invoke-AzRetry rest --method get --url $assignments --query "value[?principalId=='$deployer'].appRoleId" -o tsv)
	foreach ($value in 'user', 'tester') {
		$role = Invoke-Az ad app show --id $app --query "appRoles[?value=='$value'].id" -o tsv
		if ($assigned -contains $role) { continue }
		$body = Join-Path $work "$value.json"
		ConvertTo-Json -Compress ([ordered]@{ principalId = $deployer; resourceId = $principal; appRoleId = $role }) | Set-Content -Path $body
		Invoke-AzRetry rest --method post --url $assignments --headers 'Content-Type=application/json' --body "@$body" -o none
	}
} catch {
	Write-Warning $_
	Write-Warning @"
entra: the sign-in app registration was not finished, and the deployment carries
on without it: Entra sign-in fails for whoever it lacks. Make it by hand
(docs/deployment.md, "Sign-in with Microsoft Entra ID"), or ask whoever may
register applications in this tenant; ENTRA_APP_SETUP=false stops this attempt.
"@
	if ($Mode -eq 'redirect') {
		Write-Warning "  add the redirect URI $callback to the registration"
	} elseif ($stage) {
		Write-Warning "  assign yourself the roles user and tester: Enterprise applications -> $name -> Users and groups"
	} else {
		$redirect = if ($callback) { " --web-redirect-uris $callback" } else { '' }
		Write-Warning @"
  az ad app create --display-name $name --sign-in-audience AzureADMyOrg --app-roles @approles.json$redirect
  az ad app update --id <appId> --set groupMembershipClaims=ApplicationGroup
  az ad sp create --id <appId>
  azd env set AUTH_MICROSOFT_ENTRA_ID_ID <appId>
  azd env set AUTH_MICROSOFT_ENTRA_ID_SECRET "`$(az ad app credential reset --id <appId> --append --query password -o tsv)"
  azd provision
"@
	}
	exit 1
} finally {
	Remove-Item -Recurse -Force $work
}
