# Is the deployment answering, and refusing what it should? After `azd up`:
#
#   ./scripts/smoke.ps1
#
# Opt-in and never in CI: it talks to your deployment. It reads the azd
# environment, then checks that the frontend answers on /health and at the
# door, and that an API call without a session is refused with 401. With the
# demo's sign-in (AUTH_MODE=local) it goes on as a new person: signs in, lists
# the library (the sample's documents, unless SEED_SAMPLE_LIBRARY is false),
# sends one chat turn and reads the answer as it streams, then deletes the
# account it made, so the run leaves nothing behind. Under entra it stops
# after the unauthenticated checks: a sign-in there is a person at the
# identity provider's page, which a script is not.
$ErrorActionPreference = 'Stop'
# What stops the script is said as bash says it: the line alone, on stderr, and exit 1.
trap { [Console]::Error.WriteLine("$_"); exit 1 }

# The azd environment, as azd hands it to a hook.
Push-Location "$PSScriptRoot/.."
try { $values = azd env get-values } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'smoke: could not read the azd environment' }
foreach ($line in ($values | Where-Object { $_ })) {
	$key, $value = $line -split '=', 2
	Set-Item "env:$key" $value.Trim('"')
}
if (-not $env:FRONTEND_URL) { throw "smoke: FRONTEND_URL is not in the azd environment; run azd up first" }
$origin = $env:FRONTEND_URL.TrimEnd('/')

function Pass([string]$what) { Write-Host "smoke: ok   $what" }
function Fail([string]$what) { throw "smoke: FAIL $what" }
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# One request with the session's cookies, never throwing on a status.
function Invoke-Smoke([string]$Uri, [string]$Method = 'GET', $Body, [string]$ContentType, [hashtable]$Headers = @{}) {
	$request = @{
		Uri = $Uri; Method = $Method; WebSession = $session; Headers = $Headers
		SkipHttpErrorCheck = $true; TimeoutSec = 120
	}
	if ($null -ne $Body) { $request.Body = $Body }
	if ($ContentType) { $request.ContentType = $ContentType }
	Invoke-WebRequest @request
}

$response = Invoke-Smoke "$origin/health"
if ($response.StatusCode -ne 200) { Fail "$origin/health answered $($response.StatusCode)" }
Pass "$origin/health answers"

$response = Invoke-Smoke "$origin/login"
if ($response.StatusCode -ne 200) { Fail "the door ($origin/login) answered $($response.StatusCode)" }
Pass "the door answers"

$response = Invoke-Smoke "$origin/api/conversations"
if ($response.StatusCode -ne 401 -or $response.Content -notmatch '"unauthenticated"') {
	Fail "an API call without a session answered $($response.StatusCode): $($response.Content)"
}
Pass "an API call without a session is refused (401)"

if ($env:AUTH_MODE -ne 'local') {
	Write-Host "smoke: AUTH_MODE is $(if ($env:AUTH_MODE) { $env:AUTH_MODE } else { 'unset' }), not local: signing in takes a person at the identity provider, so the checks stop here"
	exit 0
}

# Auth.js's own sign-in: a CSRF token, then the local provider's form.
$response = Invoke-Smoke "$origin/api/auth/csrf"
$csrf = ($response.Content | ConvertFrom-Json).csrfToken
if ($response.StatusCode -ne 200 -or -not $csrf) { Fail "no CSRF token from $origin/api/auth/csrf ($($response.StatusCode))" }
# The account the run signs in as is deleted however the run ends: a check
# that fails after the sign-in still leaves nothing behind. The mark is set
# before the sign-in is sent, since a sign-in whose answer never arrived may
# have made the account all the same; 401 is the answer of a run that holds
# no session, and so made none.
$signedIn = $true
try {
$null = Invoke-Smoke "$origin/api/auth/callback/local" -Method POST -ContentType 'application/x-www-form-urlencoded' `
	-Body @{ csrfToken = $csrf; name = 'Smoke test'; callbackUrl = "$origin/chat" }
$response = Invoke-Smoke "$origin/api/conversations"
if ($response.StatusCode -ne 200) { Fail "signed in, the conversations answered $($response.StatusCode): $($response.Content)" }
Pass "a local sign-in holds a session"

$response = Invoke-Smoke "$origin/api/library?query=onboarding"
if ($response.StatusCode -ne 200) { Fail "the library answered $($response.StatusCode): $($response.Content)" }
if ($env:SEED_SAMPLE_LIBRARY -ne 'false') {
	if ($response.Content -notmatch '"Onboarding handbook"') { Fail "the library does not list the sample's documents: $($response.Content)" }
	Pass "the library lists the sample's documents"
} else {
	Pass "the library answers (SEED_SAMPLE_LIBRARY is false, so no document is expected)"
}

# One turn through the chat runtime, as the browser sends it.
$turn = @{
	method = 'agent/run'; params = @{ agentId = 'assistant' }
	body = @{
		threadId = [guid]::NewGuid().ToString(); runId = [guid]::NewGuid().ToString()
		tools = @(); context = @(); forwardedProps = @{}; state = @{}
		messages = @(@{ id = [guid]::NewGuid().ToString(); role = 'user'; content = 'Hello' })
	}
} | ConvertTo-Json -Depth 6 -Compress
$response = Invoke-Smoke "$origin/api/copilotkit" -Method POST -ContentType 'application/json' -Body $turn `
	-Headers @{ accept = 'text/event-stream' }
if ($response.StatusCode -ne 200) { Fail "the chat turn answered $($response.StatusCode): $($response.Content)" }
$stream = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { $response.Content }
if ($stream -match '"RUN_ERROR"') { Fail "the chat turn failed: $stream" }
if ($stream -notmatch '"TEXT_MESSAGE_CONTENT"' -or $stream -notmatch '"RUN_FINISHED"') { Fail "the chat turn streamed no answer: $stream" }
Pass "a chat turn streams an answer"

$response = Invoke-Smoke "$origin/api/account" -Method DELETE
# Only a delete that landed is the end of the account: one that was refused is asked again on the way out, and named.
if ($response.StatusCode -ne 204) { Fail "deleting the smoke test's account answered $($response.StatusCode)" }
$signedIn = $false
Pass "the smoke test's account is deleted"
} finally {
	if ($signedIn) {
		$left = try { (Invoke-Smoke "$origin/api/account" -Method DELETE).StatusCode } catch { 0 }
		if ($left -notin 204, 401) { Write-Warning 'smoke: the smoke test''s account could not be deleted; it is the one named "Smoke test"' }
	}
}
