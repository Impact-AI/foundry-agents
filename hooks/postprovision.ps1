# After the template: the sign-in callback on the Entra app registration,
# project connections to a knowledge base's MCP endpoint deleted, since
# nothing uses one, the project's Application Insights connection deleted
# unless AGENT_TRACING asks for it, and, behind Front Door, the edge's private link to the
# Container Apps environment approved. Control-plane and Microsoft Graph calls only; what
# lives inside the data services is written by the migrate job after the
# deploy.
$ErrorActionPreference = 'Stop'
# What stops the script is said as bash says it: the line alone, on stderr, and exit 1.
trap { [Console]::Error.WriteLine("$_"); exit 1 }

# az's default subscription is whichever was selected last on this machine; every call names the environment's.
if (-not $env:AZURE_SUBSCRIPTION_ID) { throw 'postprovision: AZURE_SUBSCRIPTION_ID is not in the azd environment' }

# The sign-in callback at the address this provision made, on the Entra app
# registration preprovision made (hooks/entra.ps1). Never fails the provision.
try { & (Join-Path $PSScriptRoot 'entra.ps1') -Mode redirect } catch { Write-Warning $_ }
$global:LASTEXITCODE = 0

# The backend asks the knowledge base itself, on both channels; a project
# connection to a base's MCP endpoint (category RemoteTool, a target under
# /knowledgebases/) is one nothing uses. Deleted where it is left; never
# fails the provision.
if ($env:AZURE_OPENAI_RESOURCE_NAME -and $env:FOUNDRY_PROJECT_ENDPOINT) {
	$project = ($env:FOUNDRY_PROJECT_ENDPOINT -split '/')[-1]
	$connections = "https://management.azure.com/subscriptions/$($env:AZURE_SUBSCRIPTION_ID)/resourceGroups/$($env:AZURE_RESOURCE_GROUP)/providers/Microsoft.CognitiveServices/accounts/$($env:AZURE_OPENAI_RESOURCE_NAME)/projects/$project/connections"
	try {
		$names = az rest --method get --url "$($connections)?api-version=2025-10-01-preview" `
			--query "value[?properties.category=='RemoteTool' && contains(properties.target, '/knowledgebases/')].name" -o tsv
		if ($LASTEXITCODE -ne 0) { throw 'list failed' }
		foreach ($name in ($names -split "`n" | Where-Object { $_ })) {
			az rest --method delete --url "$connections/$($name)?api-version=2025-10-01-preview" -o none
			if ($LASTEXITCODE -eq 0) {
				Write-Host "postprovision: deleted the project connection $name, to a knowledge base's MCP endpoint"
			} else {
				Write-Warning "postprovision: the project connection $name, to a knowledge base's MCP endpoint, could not be deleted; delete it in the portal (Management center, Connected resources)"
			}
		}
	} catch {
		Write-Warning "postprovision: the project's connections to a knowledge base's MCP endpoint could not be read; delete them in the portal (Management center, Connected resources)"
	}
	$global:LASTEXITCODE = 0
	# The project's connection to Application Insights is the switch for the
	# Agent Service's traces of every turn's words (infra/modules/foundry.bicep).
	# The template makes it only with AGENT_TRACING, but an incremental
	# deployment never deletes a resource whose condition turned false, so a
	# deployment that once had it keeps it until it is deleted here. Never
	# fails the provision; left, it is named.
	if ($env:AGENT_TRACING -ne 'true') {
		try {
			$insights = az rest --method get --url "$($connections)?api-version=2025-10-01-preview" `
				--query "value[?name=='insights' && properties.category=='AppInsights'].name" -o tsv
			if ($LASTEXITCODE -ne 0) { throw 'list failed' }
			if ($insights) {
				az rest --method delete --url "$connections/insights?api-version=2025-10-01-preview" -o none
				if ($LASTEXITCODE -eq 0) {
					Write-Host "postprovision: deleted the project connection insights, since AGENT_TRACING is off; the Agent Service no longer traces the project's turns"
				} else {
					Write-Warning "postprovision: the project connection insights could not be deleted, and the Agent Service still traces every turn's words although AGENT_TRACING is off; delete it in the portal (Management center, Connected resources)"
				}
			}
		} catch {
			Write-Warning "postprovision: the project's connections could not be read to check for insights, which traces every turn's words while it stands; with AGENT_TRACING off, delete it in the portal if it is there (Management center, Connected resources)"
		}
		$global:LASTEXITCODE = 0
	}
}

if (-not $env:FRONT_DOOR_ENDPOINT) { exit 0 }

# The edge's request alone is approved: Front Door files it with the message
# the template gives its origin (`requestMessage` in infra/modules/edge.bicep),
# which the pending connection carries as its description. Any other pending
# request on the environment is somebody's to decide, and is named.
$environmentId = az containerapp env show --subscription $env:AZURE_SUBSCRIPTION_ID -g $env:AZURE_RESOURCE_GROUP -n $env:AZURE_CONTAINER_APPS_ENVIRONMENT_NAME --query id -o tsv
if ($LASTEXITCODE -ne 0) { throw 'postprovision: could not read the Container Apps environment' }
$pending = az network private-endpoint-connection list --subscription $env:AZURE_SUBSCRIPTION_ID --id $environmentId `
	--query "[?properties.privateLinkServiceConnectionState.status=='Pending'].[id, properties.privateLinkServiceConnectionState.description]" -o tsv
if ($LASTEXITCODE -ne 0) { throw 'postprovision: could not list the private link requests on the Container Apps environment' }
foreach ($line in ($pending -split "`n" | Where-Object { $_ })) {
	$connection, $description = $line -split "`t", 2
	if ($description -ceq 'frontend') {
		az network private-endpoint-connection approve --subscription $env:AZURE_SUBSCRIPTION_ID --id $connection --description 'front door' -o none
		if ($LASTEXITCODE -ne 0) { throw "postprovision: could not approve the edge's private link $connection" }
	} else {
		Write-Warning "postprovision: left pending a private link request that is not the edge's (`"$description`"): $connection. If it is yours: az network private-endpoint-connection approve --subscription $($env:AZURE_SUBSCRIPTION_ID) --id $connection"
	}
}
