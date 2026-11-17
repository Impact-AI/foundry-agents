# The data resources are locked against deletion; `azd down` is the one
# deletion that is meant, so the locks come off first.
$ErrorActionPreference = 'Stop'
# What stops the script is said as bash says it: the line alone, on stderr, and exit 1.
trap { [Console]::Error.WriteLine("$_"); exit 1 }
# az's default subscription is whichever was selected last on this machine; every call names the environment's.
if (-not $env:AZURE_SUBSCRIPTION_ID) { throw 'predown: AZURE_SUBSCRIPTION_ID is not in the azd environment' }

# The group and the account are the template's outputs, which an environment
# whose provision never completed does not hold. The group's name is the
# template's own (`rg-<environment>`, names.resourceGroup in infra/main.bicep),
# and the accounts are asked of the group, so what a failed provision made
# before it failed is taken down too. A group that does not exist has nothing
# to take down.
$group = $env:AZURE_RESOURCE_GROUP
if (-not $group) {
	if (-not $env:AZURE_ENV_NAME) { throw 'predown: neither AZURE_RESOURCE_GROUP nor AZURE_ENV_NAME is in the azd environment' }
	$group = "rg-$env:AZURE_ENV_NAME"
}
$exists = az group exists --subscription $env:AZURE_SUBSCRIPTION_ID -n $group
if ($LASTEXITCODE -ne 0) { throw "predown: could not ask whether $group exists" }
if ("$exists".Trim() -ne 'true') { exit 0 }

$locks = az lock list --subscription $env:AZURE_SUBSCRIPTION_ID -g $group --query '[].id' -o tsv
if ($LASTEXITCODE -ne 0) { throw "predown: could not list the locks of $group" }
foreach ($lock in ($locks -split "`n" | Where-Object { $_ })) {
	az lock delete --subscription $env:AZURE_SUBSCRIPTION_ID --ids $lock -o none
	if ($LASTEXITCODE -ne 0) { throw "predown: could not delete the lock $lock" }
}

# The Agent Service's capability hosts come off before the account: each
# project's first, then the account's, which is what lets go of an injected
# subnet (Azure finishes releasing it in the background, up to about twenty
# minutes). A group with no account, or whose account is already gone, has
# nothing to take down.
$account = $env:AZURE_OPENAI_RESOURCE_NAME
if (-not $account) {
	$accounts = az cognitiveservices account list --subscription $env:AZURE_SUBSCRIPTION_ID -g $group --query "[?kind=='AIServices'].name" -o tsv
	if ($LASTEXITCODE -ne 0) { throw "predown: could not list the accounts of $group" }
	$account = @($accounts -split "`n" | Where-Object { $_ })[0]
}
if (-not $account) { exit 0 }
$api = '2025-12-01'
$accountId = "/subscriptions/$env:AZURE_SUBSCRIPTION_ID/resourceGroups/$group/providers/Microsoft.CognitiveServices/accounts/$account"
$missing = az resource show --subscription $env:AZURE_SUBSCRIPTION_ID --ids $accountId --api-version $api -o none 2>&1
if ($LASTEXITCODE -ne 0) {
	if ("$missing" -match 'NotFound') { exit 0 }
	throw "predown: $missing"
}

# The ids of a resource's children of one type.
function Get-Children([string]$id, [string]$type) {
	$ids = az rest --subscription $env:AZURE_SUBSCRIPTION_ID --method get --url "https://management.azure.com$id/$type`?api-version=$api" --query 'value[].id' -o tsv
	if ($LASTEXITCODE -ne 0) { throw "predown: could not list $type under $id" }
	$ids -split "`n" | Where-Object { $_ }
}

function Remove-Host([string]$id) {
	az resource delete --subscription $env:AZURE_SUBSCRIPTION_ID --ids $id --api-version $api -o none
	if ($LASTEXITCODE -ne 0) { throw "predown: could not delete $id" }
}

foreach ($project in (Get-Children $accountId 'projects')) {
	foreach ($hostId in (Get-Children $project 'capabilityHosts')) { Remove-Host $hostId }
}
foreach ($hostId in (Get-Children $accountId 'capabilityHosts')) { Remove-Host $hostId }
