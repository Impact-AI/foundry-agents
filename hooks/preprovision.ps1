# Before the template runs: which secrets the vault already holds and which
# services already run, so the template replaces neither with a placeholder;
# the session secret it writes into Key Vault, generated once, when neither
# the azd environment nor the vault has one (azure.yaml's pipeline.secrets
# carries it to CI); the resource providers the template needs; and whether
# the signed-in principal is a person or a pipeline, which its role
# assignments are typed with; and, for Entra sign-in, the app registration.
$ErrorActionPreference = 'Stop'
# What stops the hook is said as its one line on stderr, as bash says it, and
# never as PowerShell's error record around it.
trap { [Console]::Error.WriteLine("$_"); exit 1 }
# An empty argument is handed to a native command as an empty argument, which
# PowerShell before 7.3 dropped.
$PSNativeCommandArgumentPassing = 'Standard'

# The components chosen at deploy time (docs/deployment.md, "Choose components
# at deploy time"), refused before anything is made when a value is unknown or
# a pair cannot work. The same rules and words as RULES in
# apps/backend/src/components.ts and as preprovision.sh; the migrate job applies
# them again, to the stored documents too, from inside the network.
$privateNetworking = if ($env:PRIVATE_NETWORKING) { $env:PRIVATE_NETWORKING } elseif ($env:HARDENED) { $env:HARDENED } else { 'false' }
$refused = @()
$components = [ordered]@{
	MEMORY_STORE     = @('foundry', 'own')
	HISTORY_STORE    = @('own', 'foundry')
	VOICE_ENGINE     = @('cascade', 'speechToSpeech')
	RETRIEVAL_ENGINE = @('hybrid', 'knowledgeBase')
}
foreach ($name in $components.Keys) {
	$value = [Environment]::GetEnvironmentVariable($name)
	if ($value -and -not ($components[$name] -ccontains $value)) {
		$refused += "components.unknown_value: $name is $value, which is not one of $($components[$name] -join ', '). Set it to one of them, or unset it for the default."
	}
}
if ($privateNetworking -ceq 'true' -and $env:MEMORY_STORE -ceq 'foundry') {
	$refused += 'agent.memory.store_unreachable_private: memory.store is foundry on a private deployment (PRIVATE_NETWORKING), where the Foundry memory store extraction calls the account from public Microsoft addresses and is refused 403; Microsoft documents that VNet integration is not supported for memory stores. Set MEMORY_STORE=own (azd env set MEMORY_STORE own), and memory.store to own in the app/agent document if it exists.'
}
# Zones go with the network. The template would make a zone-redundant
# Container Apps environment with no subnet, which the platform refuses after
# the data services exist, Cosmos DB among them in a mode it cannot leave.
$zoneRedundant = if ($env:ZONE_REDUNDANT) { $env:ZONE_REDUNDANT } elseif ($env:HARDENED) { $env:HARDENED } else { 'false' }
if ($zoneRedundant -ceq 'true' -and $privateNetworking -cne 'true') {
	$refused += 'deployment.zones_need_network: ZONE_REDUNDANT is on (set, or through HARDENED) without PRIVATE_NETWORKING. A zone-redundant Container Apps environment needs a virtual network with an infrastructure subnet, which only private networking makes, and Cosmos DB takes zone redundancy once, when its account is created. Set ZONE_REDUNDANT=false (azd env set ZONE_REDUNDANT false), or PRIVATE_NETWORKING=true.'
}
if ($refused.Count -gt 0) {
	foreach ($line in $refused) { [Console]::Error.WriteLine("preprovision: $line") }
	exit 1
}

# az's default subscription is whichever was selected last on this machine; every call names the environment's.
if (-not $env:AZURE_SUBSCRIPTION_ID) { throw 'preprovision: AZURE_SUBSCRIPTION_ID is not in the azd environment' }

# What the resource group already holds, asked of Azure Resource Manager,
# which answers for a resource whose own listener is closed. A group that
# does not exist yet holds nothing. What exists and cannot be asked stops the
# provision: it would otherwise replace what it could not see.
$group = if ($env:AZURE_RESOURCE_GROUP) { $env:AZURE_RESOURCE_GROUP } else { "rg-$($env:AZURE_ENV_NAME)" }
$held = @()
$running = @()
$groupExists = az group exists --subscription $env:AZURE_SUBSCRIPTION_ID -n $group
if ($LASTEXITCODE -ne 0) { throw "preprovision: could not ask whether the resource group $group exists" }
if ($groupExists -ceq 'true') {
	# The secrets the vault holds. The template writes a placeholder for a
	# secret with no value only while the vault does not hold it, so a
	# provision whose environment carries no value for one (a pipeline's
	# runner, a second machine) leaves a working secret as it is. The answer
	# comes a page at a time, each naming the next.
	$vault = az resource list --subscription $env:AZURE_SUBSCRIPTION_ID -g $group --resource-type Microsoft.KeyVault/vaults --query '[0].name' -o tsv
	if ($LASTEXITCODE -ne 0) { throw "preprovision: could not list the vaults of the resource group $group" }
	if ($vault) {
		$secrets = "/subscriptions/$($env:AZURE_SUBSCRIPTION_ID)/resourceGroups/$group/providers/Microsoft.KeyVault/vaults/$vault/secrets"
		# A later page is asked for by the token the page before it gave, as a
		# parameter of its own: the address a page names carries an ampersand,
		# which a Windows command line splits a command at, so neither twin
		# hands that address on. That the token travels as `$skiptoken` is
		# known only from the service's behaviour.
		$token = ''
		while ($true) {
			$page = @('--url-parameters', 'api-version=2023-07-01')
			if ($token) { $page += ('$skiptoken=' + $token) }
			# The first line is the next page's address, empty on the last; the rest are names.
			$answer = @(az rest --method get --url $secrets @page --query "[nextLink || '', value[].name][]" -o tsv)
			if ($LASTEXITCODE -ne 0) {
				throw "preprovision: could not ask which secrets the vault $vault holds, and a provision that does not know would replace them with placeholders. Sign az in to an identity that can read the resource group $group, then provision again."
			}
			$next = if ($answer.Count -gt 0) { $answer[0] } else { '' }
			$held += @($answer | Select-Object -Skip 1 | Where-Object { $_ })
			if (-not $next) { break }
			if ($next -notmatch '[?&](?:\$|%24)skiptoken=([^&]*)') {
				throw "preprovision: the list of the vault $vault's secrets names a next page with no token to ask for it by, so what it holds is not known. Provision again."
			}
			$following = [uri]::UnescapeDataString($Matches[1])
			if ($following -ceq $token) {
				throw "preprovision: the list of the vault $vault's secrets names the page just read as the next one, so what it holds is not known. Provision again."
			}
			$token = $following
		}
	}
	# The services whose container app exists, by the tag azd finds them by.
	# With no image named, the template keeps the image such an app runs, and
	# asks azd whether it exists; this is the same answer from the resource
	# group itself, so a lookup of azd's that failed does not put the
	# placeholder over a running app. Every app's tags are asked for whole and
	# the one tag read here: a query that names it needs a quoted key, and a
	# Windows command line takes the quotes out of an argument.
	$tags = az resource list --subscription $env:AZURE_SUBSCRIPTION_ID -g $group --resource-type Microsoft.App/containerApps --query '[].tags' -o json
	if ($LASTEXITCODE -ne 0) {
		throw "preprovision: could not ask which container apps the resource group $group holds, and a provision that does not know could replace a running app's image with the placeholder. Sign az in to an identity that can read the resource group, then provision again."
	}
	$tagged = @(($tags -join "`n") | ConvertFrom-Json | Where-Object { $_ } | ForEach-Object { $_.'azd-service-name' })
	$running = @($tagged | Where-Object { $_ -ceq 'backend' -or $_ -ceq 'frontend' } | Sort-Object -Unique -CaseSensitive)
}
# Never an empty value: `none` names nothing, and an empty argument is not
# one every shell hands on.
azd env set KEY_VAULT_HOLDS $(if ($held.Count) { $held -join ',' } else { 'none' })
if ($LASTEXITCODE -ne 0) { throw 'preprovision: could not set KEY_VAULT_HOLDS in the azd environment' }
azd env set SERVICES_RUNNING $(if ($running.Count) { $running -join ',' } else { 'none' })
if ($LASTEXITCODE -ne 0) { throw 'preprovision: could not set SERVICES_RUNNING in the azd environment' }

# The session secret, made once: when the environment carries none and the
# vault holds none either. A machine whose environment has no copy of a
# secret the vault holds makes no new one, which would sign everybody out and
# reach the two apps at different times; the template then leaves the vault's
# alone. azd hands every hook its environment as variables; `azd env
# get-value` is not used because a missing key prints its error on stdout.
if (-not $env:AUTH_SECRET -and $held -cnotcontains 'auth-secret') {
	$bytes = [byte[]]::new(32)
	[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
	azd env set AUTH_SECRET (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
	if ($LASTEXITCODE -ne 0) { throw 'preprovision: could not set AUTH_SECRET in the azd environment' }
}

# The Agent Service injected into a subnet runs on Container Apps and AKS, and
# an account injected before both providers are registered is left Failed.
# Registering is idempotent and free, so it happens whether or not this
# environment injects.
foreach ($namespace in 'Microsoft.App', 'Microsoft.ContainerService') {
	if ((az provider show --subscription $env:AZURE_SUBSCRIPTION_ID -n $namespace --query registrationState -o tsv) -cne 'Registered') {
		az provider register --subscription $env:AZURE_SUBSCRIPTION_ID -n $namespace --wait -o none
		if ($LASTEXITCODE -ne 0) { throw "preprovision: could not register the resource provider $namespace" }
	}
}

# The realtime model the voice agent's default speech-to-speech engine runs on
# (`realtime` in the parameter file's models) is offered in few regions, and a
# region that does not offer it fails the provision late, beside everything
# else it made. Said here instead, before anything is made, from what the
# region offers this subscription. Without the deployment, live voice runs as
# a cascade on the chat deployment, so taking it out of the parameter file is
# the way to deploy to such a region. A region az cannot be asked about is
# reported and not refused: the provision decides.
$parameters = Get-Content -Raw (Join-Path $PSScriptRoot '..' 'infra' 'main.parameters.json') | ConvertFrom-Json
$realtime = $parameters.parameters.models.value.realtime
if ($realtime -and $env:AZURE_LOCATION) {
	$query = "[?model.name=='$($realtime.model)' && model.version=='$($realtime.version)'].model.skus[].name"
	$offered = az cognitiveservices model list --subscription $env:AZURE_SUBSCRIPTION_ID -l $env:AZURE_LOCATION --query $query -o tsv
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "preprovision: could not ask $($env:AZURE_LOCATION) whether it offers $($realtime.model) $($realtime.version) as $($realtime.sku); the provision will say"
	} elseif (@($offered) -cnotcontains $realtime.sku) {
		throw @"
preprovision: $($env:AZURE_LOCATION) does not offer $($realtime.model) $($realtime.version) as $($realtime.sku), the realtime
model the voice agent's speech-to-speech engine runs on (models.realtime in
infra/main.parameters.json). Either:

  * deploy to a region that offers it, on an environment that has made nothing yet
    (docs/configuration.md, "The realtime deployment", names them):
      azd env set AZURE_LOCATION <region>

  * or take "realtime" out of models in infra/main.parameters.json: live voice then
    runs as a cascade on the chat deployment.
"@
	}
}

# Azure refuses a Linux VM with neither a password nor a key, and the jump VM
# is signed in to with Entra ID alone: a key it holds, whose private half is
# deleted here unseen.
if ($env:DEVELOPER_ACCESS -ceq 'true' -and -not $env:DEVELOPER_ACCESS_SSH_KEY) {
	$keys = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
	New-Item -ItemType Directory -Path $keys | Out-Null
	try {
		ssh-keygen -q -t ed25519 -N '' -C jump-host -f (Join-Path $keys 'key')
		if ($LASTEXITCODE -ne 0) { throw 'preprovision: ssh-keygen could not make the jump VM its key' }
		azd env set DEVELOPER_ACCESS_SSH_KEY (Get-Content -Raw (Join-Path $keys 'key.pub')).Trim()
		if ($LASTEXITCODE -ne 0) { throw 'preprovision: could not set DEVELOPER_ACCESS_SSH_KEY in the azd environment' }
	} finally {
		Remove-Item -Recurse -Force $keys
	}
}

if ((az account show --subscription $env:AZURE_SUBSCRIPTION_ID --query user.type -o tsv) -ceq 'user') {
	azd env set AZURE_PRINCIPAL_TYPE User
} else {
	azd env set AZURE_PRINCIPAL_TYPE ServicePrincipal
}
if ($LASTEXITCODE -ne 0) { throw 'preprovision: could not set AZURE_PRINCIPAL_TYPE in the azd environment' }

# Entra sign-in's app registration, made for the deployer while the
# environment has none, so this provision writes its values to Key Vault
# (hooks/entra.ps1). Never fails the provision: what it could not do, it says.
$env:KEY_VAULT_HOLDS = $(if ($held.Count) { $held -join ',' } else { 'none' })
try { & (Join-Path $PSScriptRoot 'entra.ps1') -Mode register } catch { Write-Warning $_ }
$global:LASTEXITCODE = 0
