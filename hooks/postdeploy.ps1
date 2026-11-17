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
$ErrorActionPreference = 'Stop'
# What stops the script is said as bash says it: the line alone, on stderr, and exit 1.
trap { [Console]::Error.WriteLine("$_"); exit 1 }
. "$PSScriptRoot/job.ps1"

Assert-Subscription postdeploy
if (-not $env:SERVICE_BACKEND_IMAGE_NAME) { throw 'azd sets SERVICE_BACKEND_IMAGE_NAME after deploying the backend' }
# The app named, given the probes named (JSON), unless it holds some. The
# container is read whole, at the API version the patch is sent with (az
# containerapp show reads a later one, whose container carries properties
# this version refuses), the probes set on it, and sent back as a merge
# patch: the one container replaces the list, everything else on the app
# stays. The revision suffix is cleared, since azd's names the revision it
# just made and a second revision cannot take it. The body travels as a file:
# a double quote inside an argument does not reach az.cmd.
function Set-Probes([string]$Name, [string]$Probes) {
	if (-not $Name -or -not $Probes) {
		[Console]::Error.WriteLine('postdeploy: the azd environment names no app or no probes to give it; azd provision gives the probes')
		return
	}
	$held = az containerapp show --subscription $env:AZURE_SUBSCRIPTION_ID -g $env:AZURE_RESOURCE_GROUP -n $Name --query 'properties.template.containers[0].probes[0].type' -o tsv
	if ($LASTEXITCODE -ne 0) { throw "postdeploy: could not read the app $Name" }
	if ($held) { return }
	$app = "/subscriptions/$env:AZURE_SUBSCRIPTION_ID/resourceGroups/$env:AZURE_RESOURCE_GROUP/providers/Microsoft.App/containerApps/$Name"
	$container = az rest --subscription $env:AZURE_SUBSCRIPTION_ID --method get --url $app --url-parameters api-version=2026-01-01 --query 'properties.template.containers[0]' -o json
	if ($LASTEXITCODE -ne 0) { throw "postdeploy: could not read the app $Name" }
	$container = ($container -join "`n") | ConvertFrom-Json
	$container | Add-Member -NotePropertyName probes -NotePropertyValue @($Probes | ConvertFrom-Json) -Force
	$body = (New-TemporaryFile).FullName
	ConvertTo-Json -Depth 32 -Compress @{ properties = @{ template = @{ revisionSuffix = $null; containers = @($container) } } } | Set-Content -Path $body
	az rest --subscription $env:AZURE_SUBSCRIPTION_ID --method patch --url $app --url-parameters api-version=2026-01-01 --body "@$body" -o none
	$sent = $LASTEXITCODE
	Remove-Item -Path $body -Force
	if ($sent -ne 0) { throw "postdeploy: could not give the app $Name its health probes" }
	Write-Host "postdeploy: $Name given its health probes"
}
Set-Probes $env:BACKEND_APP_NAME $env:BACKEND_PROBES
Set-Probes $env:FRONTEND_APP_NAME $env:FRONTEND_PROBES

$steps = Get-DeploySteps
Update-MigrateJob --image $env:SERVICE_BACKEND_IMAGE_NAME --args @steps
Invoke-MigrateJob "deploy ($($steps[1..($steps.Length - 1)] -join ' '))"
