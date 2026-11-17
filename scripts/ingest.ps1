# Make a directory of your own documents a library of the knowledge base, or
# take a library out of it:
#
#   ./scripts/ingest.ps1 [-DryRun] [-OpenListener [-Ip <address>]] <dir> [name]
#   ./scripts/ingest.ps1 [-DryRun] [-OpenListener [-Ip <address>]] -Remove <name>
#   ./scripts/ingest.ps1 -CloseLeftover
#
# The directory is mirrored to the library container under <name>/ (the
# directory's own name by default), as you with --auth-mode login: every file
# whose bytes its blob does not already hold uploaded, every blob under
# <name>/ the directory no longer has deleted. Then the migrate job loads
# that prefix from inside the network: it describes each file in its blob's
# metadata (readers from access.json, title and tags from front matter or
# catalog.json), runs AI Search's indexer and waits for it, deletes the
# chunks of files that have gone, and has Prompt Shields read every new
# chunk. A file that did not change is not uploaded, so the indexer reads it
# no more, and a file of a format no library takes is named and never sent.
# -Remove deletes the prefix and every chunk of the library; -DryRun names
# each file that would be uploaded and each blob that would be deleted, and
# uploads, deletes and loads nothing. With private networking on, the
# account has no public listener and its firewall denies by default, so the
# mirror cannot reach it from outside the network: the script refuses,
# naming the two ways through, unless -OpenListener is given, which turns
# the listener on and adds one firewall rule, for this machine's public IPv4
# address, for the mirror alone, and takes both back before the job runs —
# and on exit, whether the run ends by itself, by an error or by a signal
# the runtime hands a program (a terminal closed, a termination asked for).
# A dry run has to list the blobs too, so with -OpenListener it opens and
# closes the account the same way. The firewall's default stays Deny, so the
# rule lets in this address and no other. The address is the one -Ip names,
# or else the one https://api.ipify.org reports to this machine; either must
# be a public one, which is the only kind a storage firewall rule admits.
#
# What the script opened it says on the account itself, in a tag
# (ingestListener: the run, the address, what it opened and when), written
# before it opens anything and taken off once it has closed, so every
# machine sees it. A run that finds the tag touches nothing of another run's:
# while the tag is younger than an hour it refuses, since that run may still
# be uploading; older, it closes what the tag names when the address is this
# machine's own, and otherwise refuses. -CloseLeftover closes what the tag
# names whatever its age, for a run known to have ended. Closing takes out
# the rule the tag names and turns the listener off only where the firewall
# still denies by default: an account made public since is left public. A
# hidden file or directory (a name starting with a dot) and a symbolic link
# are never sent.
[CmdletBinding(DefaultParameterSetName = 'Load')]
param(
	[Parameter(ParameterSetName = 'Load', Position = 0)][string]$Directory,
	[Parameter(ParameterSetName = 'Load', Position = 1)][string]$Name,
	[Parameter(ParameterSetName = 'Remove', Mandatory = $true)][string]$Remove,
	[switch]$CloseLeftover,
	[switch]$DryRun,
	[switch]$OpenListener,
	[string]$Ip
)
$ErrorActionPreference = 'Stop'
# What stops the script is said as bash says it: the line alone, on stderr, and exit 1.
trap { [Console]::Error.WriteLine("$_"); exit 1 }
# A command line the script cannot act on: said, and exit 2, before any call.
function Stop-Usage([string]$what) { [Console]::Error.WriteLine($what); exit 2 }
# Asked for this machine's public address only under -OpenListener without -Ip.
$ipLookup = 'https://api.ipify.org'
# Four octets of at most 255.
function Test-Ipv4([string]$address) {
	if ($address -notmatch '^([0-9]{1,3}\.){3}[0-9]{1,3}$') { return $false }
	foreach ($octet in $address.Split('.')) { if ([int]$octet -gt 255) { return $false } }
	return $true
}
# An address the internet reaches a machine by. A storage firewall rule
# admits no other kind: not a private network's, not a carrier's shared
# range, not a loopback, link-local, multicast or reserved one.
function Test-PublicAddress([string]$address) {
	$a, $b = $address.Split('.')[0..1] | ForEach-Object { [int]$_ }
	if ($a -in 0, 10, 127) { return $false }
	if ($a -eq 100 -and $b -ge 64 -and $b -le 127) { return $false }
	if ($a -eq 169 -and $b -eq 254) { return $false }
	if ($a -eq 172 -and $b -ge 16 -and $b -le 31) { return $false }
	if ($a -eq 192 -and $b -eq 168) { return $false }
	return $a -lt 224
}
# The address as a firewall rule holds it: each octet without leading zeros,
# so one address is one text wherever it is compared, written or asked for.
function Get-CanonicalAddress([string]$address) { ($address.Split('.') | ForEach-Object { [int]$_ }) -join '.' }
# How long a run's tag is taken for a run still uploading, in seconds.
$leftoverAfter = 3600
if ($Ip -and -not (Test-Ipv4 $Ip)) { Stop-Usage "ingest: -Ip takes an IPv4 address; `"$Ip`" is not one" }
if ($Ip -and -not (Test-PublicAddress $Ip)) {
	Stop-Usage "ingest: $Ip is not a public address, and a storage firewall rule admits no other; pass the IPv4 address the internet sees this machine by"
}
if ($Ip) { $Ip = Get-CanonicalAddress $Ip }
. "$PSScriptRoot/../hooks/job.ps1"
. "$PSScriptRoot/../hooks/private.ps1"

$dir = $null
# Nothing to load: the leftover is closed and the run ends.
$closeOnly = $CloseLeftover -and -not $Remove -and -not $Directory
if ($closeOnly) {
} elseif ($Remove) {
	$Name = $Remove
} else {
	if (-not $Directory) { Stop-Usage 'usage: ingest.ps1 [-DryRun] [-OpenListener [-Ip <address>]] <dir> [name] | [-DryRun] [-OpenListener [-Ip <address>]] -Remove <name> | -CloseLeftover' }
	# Every path is taken as it is written: a bracket in a name is a character of it, never a pattern.
	if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { Stop-Usage "ingest: $Directory is not a directory" }
	$dir = (Resolve-Path -LiteralPath $Directory).Path
	if (-not $Name) { $Name = [IO.Path]::GetFileName($dir.TrimEnd('/', '\')) }
}
if (-not $closeOnly -and $Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
	Stop-Usage "ingest: `"$Name`" is not a library name (letters, digits, . _ -); pass one as the second argument"
}
$files = @()
if ($dir) {
	# The files the job takes, by the name upload-batch gives each: a format
	# a library holds, and the two manifests at its root. Anything else is
	# named here and never sent, as the job would skip it unread; a blob of
	# one an earlier run sent is deleted as gone. The formats are the job's
	# (`formatOf` in platform/knowledge/src/library/formats.ts), and
	# ingest.test.ts holds this line to that list.
	$formats = 'pdf|docx|doc|pptx|ppt|xlsx|xls|html|htm|md|txt|csv|png|jpg|jpeg|gif'
	# A name starting with a dot is hidden, and nothing under it is read; a
	# symbolic link is not followed, so nothing outside the directory is sent.
	$links = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
	# A link to a directory is listed as the link it is, and never entered. A
	# file that has a second name in the file system (a hard link) is an
	# ordinary file under each of them.
	$symbolic = 'SymbolicLink', 'Junction'
	foreach ($rel in (Get-ChildItem -LiteralPath $dir -Recurse -Force | Where-Object { $_.LinkType -in $symbolic -or -not $_.PSIsContainer } | ForEach-Object {
		$path = [IO.Path]::GetRelativePath($dir, $_.FullName).Replace('\', '/')
		if ($_.LinkType -in $symbolic) { [void]$links.Add($path) }
		$path
	} | Where-Object { $_ -notmatch '(^|/)\.' } | Sort-Object -CaseSensitive)) {
		if ($links.Contains($rel)) {
			Write-Host "ingest: skipping $dir/$rel, a symbolic link"
		} elseif ($rel -eq 'access.json' -or $rel -eq 'catalog.json' -or [IO.Path]::GetFileName($rel) -imatch "^.+\.($formats)$") {
			$files += $rel
		} else {
			Write-Host "ingest: skipping $dir/$rel, not a format a library takes"
		}
	}
	if ($files.Count -eq 0) { Stop-Usage "ingest: $dir holds no file a library takes" }
}

# The azd environment, as azd hands it to a hook.
Push-Location "$PSScriptRoot/.."
try { $values = azd env get-values } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'ingest: could not read the azd environment' }
foreach ($line in ($values | Where-Object { $_ })) {
	$key, $value = $line -split '=', 2
	Set-Item "env:$key" $value.Trim('"')
}
foreach ($variable in 'AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP', 'AZURE_STORAGE_ACCOUNT', 'AZURE_STORAGE_LIBRARY_CONTAINER', 'MIGRATE_JOB_NAME') {
	if (-not [Environment]::GetEnvironmentVariable($variable)) { throw "ingest: $variable is not in the azd environment; run azd up first" }
}
$container = $env:AZURE_STORAGE_LIBRARY_CONTAINER

$account = @('--subscription', $env:AZURE_SUBSCRIPTION_ID, '-g', $env:AZURE_RESOURCE_GROUP, '-n', $env:AZURE_STORAGE_ACCOUNT)
$firewall = @('--subscription', $env:AZURE_SUBSCRIPTION_ID, '-g', $env:AZURE_RESOURCE_GROUP, '--account-name', $env:AZURE_STORAGE_ACCOUNT)
$store = @('--subscription', $env:AZURE_SUBSCRIPTION_ID, '--auth-mode', 'login', '--account-name', $env:AZURE_STORAGE_ACCOUNT)
$accountId = "/subscriptions/$($env:AZURE_SUBSCRIPTION_ID)/resourceGroups/$($env:AZURE_RESOURCE_GROUP)/providers/Microsoft.Storage/storageAccounts/$($env:AZURE_STORAGE_ACCOUNT)"
# What is still to take back: the listener to turn off, the rule to take
# out, the address the rule admits, and the tag that says so on the account.
# `$unclosed` is set once a close has been given up on, so the exit path does
# not ask three more times.
$opened = $false
$ruled = $false
$admitted = ''
$tag = ''
$unclosed = $false
# The tag on the account: `<run>:<address>:<listener|listener+rule>:<when>`,
# the time in seconds since the epoch. Merge writes this one tag and leaves
# the account's others; Delete takes this one off.
function Set-AccountTag([string]$operation, [string]$value) {
	az tag update --subscription $env:AZURE_SUBSCRIPTION_ID --resource-id $accountId --operation $operation --tags "ingestListener=$value" -o none
	return $LASTEXITCODE -eq 0
}
# The listener, the firewall's default and the tag, as the account has them now.
function Read-Account {
	$answer = @(az storage account show @account --query "[publicNetworkAccess, networkRuleSet.defaultAction, tags.ingestListener || '']" -o tsv)
	if ($LASTEXITCODE -ne 0) { throw "ingest: could not read $($env:AZURE_STORAGE_ACCOUNT)" }
	$script:publicAccess = "$($answer[0])"
	$script:defaultAction = if ($answer.Count -gt 1) { "$($answer[1])" } else { '' }
	$script:tagged = if ($answer.Count -gt 2) { "$($answer[2])" } else { '' }
}
# Turns the listener off and takes the rule out again, then takes the tag
# off. Each is asked whatever became of the other, and asked again when the
# service refuses it; what never lands is named, exactly, with the command
# that does it by hand, and fails the run. The tag stays while anything it
# names is still open, so the next run can see it.
function Close-Listener {
	foreach ($attempt in 1..3) {
		if ($script:opened) {
			az storage account update @account --public-network-access Disabled -o none
			if ($LASTEXITCODE -eq 0) { $script:opened = $false }
		}
		if ($script:ruled) {
			az storage account network-rule remove @firewall --ip-address $script:admitted -o none
			if ($LASTEXITCODE -eq 0) { $script:ruled = $false }
		}
		if (-not ($script:opened -or $script:ruled)) { break }
		if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
	}
	if (-not ($script:opened -or $script:ruled)) {
		Write-Host "ingest: $($env:AZURE_STORAGE_ACCOUNT)'s public listener is off again"
		if ($script:tag) {
			if (Set-AccountTag 'Delete' $script:tag) {
				$script:tag = ''
			} else {
				[Console]::Error.WriteLine("ingest: could not take the ingestListener tag off $($env:AZURE_STORAGE_ACCOUNT), which is closed; the next run refuses until it is gone. Take it off: az tag update --subscription $($env:AZURE_SUBSCRIPTION_ID) --resource-id $accountId --operation Delete --tags ingestListener=$($script:tag)")
			}
		}
		return
	}
	$script:unclosed = $true
	$byHand = ''
	if ($script:opened) {
		$byHand += "`ningest: THE PUBLIC LISTENER OF $($env:AZURE_STORAGE_ACCOUNT) IS STILL ON. Close it now:`n  az storage account update --subscription $($env:AZURE_SUBSCRIPTION_ID) -g $($env:AZURE_RESOURCE_GROUP) -n $($env:AZURE_STORAGE_ACCOUNT) --public-network-access Disabled"
	}
	if ($script:ruled) {
		$byHand += "`ningest: THE FIREWALL RULE FOR $($script:admitted) ON $($env:AZURE_STORAGE_ACCOUNT) IS STILL THERE. Remove it now:`n  az storage account network-rule remove --subscription $($env:AZURE_SUBSCRIPTION_ID) -g $($env:AZURE_RESOURCE_GROUP) --account-name $($env:AZURE_STORAGE_ACCOUNT) --ip-address $($script:admitted)"
	}
	throw $byHand
}
# This machine's public address, into `$Ip`: the one given, or the one the
# lookup says, or none.
function Find-OwnAddress {
	if ($script:Ip) { return }
	$found = "$(curl -fsS --max-time 10 $ipLookup)".Trim()
	if ($LASTEXITCODE -eq 0 -and (Test-Ipv4 $found) -and (Test-PublicAddress $found)) { $script:Ip = Get-CanonicalAddress $found }
}

$publicAccess = ''
$defaultAction = ''
$tagged = ''
Read-Account
# A tag on the account is a run that opened it and has not closed it: one
# still uploading, or one that ended before it could close.
if ($tagged) {
	$leftRun, $leftIp, $leftWhat, $leftAt = $tagged -split ':', 4
	$byHand = "az tag update --subscription $($env:AZURE_SUBSCRIPTION_ID) --resource-id $accountId --operation Delete --tags ingestListener=$tagged"
	if (-not (Test-Ipv4 "$leftIp") -or "$leftAt" -notmatch '^[0-9]+$' -or $leftWhat -cnotin 'listener', 'listener+rule') {
		# Not a tag this script writes: it says nothing of what to close.
		if (-not $CloseLeftover) {
			throw "ingest: $($env:AZURE_STORAGE_ACCOUNT) carries a tag ingestListener=$tagged that this script did not write, so it does not say what was opened. Look at the account, then take the tag off ($byHand), or run with -CloseLeftover, which takes it off and touches nothing else."
		}
		if (-not (Set-AccountTag 'Delete' $tagged)) { throw "ingest: could not take the ingestListener tag off $($env:AZURE_STORAGE_ACCOUNT)" }
		Write-Host "ingest: took the tag ingestListener=$tagged off $($env:AZURE_STORAGE_ACCOUNT); it was not one this script wrote, so nothing else was touched"
	} else {
		$age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$leftAt
		$minutes = [Math]::Floor($age / 60)
		if (-not $CloseLeftover) {
			if ($age -le $leftoverAfter) {
				throw "ingest: another run of this script opened $($env:AZURE_STORAGE_ACCOUNT) for $leftIp $minutes minute(s) ago and may still be uploading; nothing of it was touched. Run again when it has ended. If it ended without closing, run with -CloseLeftover."
			}
			Find-OwnAddress
			if ($Ip -cne $leftIp) {
				throw "ingest: a run of this script opened $($env:AZURE_STORAGE_ACCOUNT) for $leftIp $minutes minute(s) ago and did not close it, and that is not this machine's address, so nothing of it was touched. Run with -CloseLeftover to close it."
			}
		}
		$tag = $tagged
		$admitted = $leftIp
		$ruled = $leftWhat -ceq 'listener+rule'
		# An account whose firewall no longer denies by default is public by
		# design since: its listener is not this script's to turn off.
		if ($defaultAction -ceq 'Deny') {
			$opened = $true
		} else {
			Write-Host "ingest: $($env:AZURE_STORAGE_ACCOUNT)'s firewall no longer denies by default, so its listener is left on"
		}
		$what = "$(if ($ruled) { ': its firewall rule' })$(if ($opened) { "$(if ($ruled) { ' and' }) its public listener" })"
		Write-Host "ingest: closing what a run from $leftIp left open on $($env:AZURE_STORAGE_ACCOUNT) $minutes minute(s) ago$what"
		Close-Listener
	}
	Read-Account
} elseif ($closeOnly) {
	Write-Host "ingest: $($env:AZURE_STORAGE_ACCOUNT) carries no ingestListener tag: no run of this script left it open"
}
if ($closeOnly) { return }

$rules = @()
$opening = $false
if ($publicAccess -eq 'Disabled') {
	$flags = "$(if ($DryRun) { ' -DryRun' })$(if ($Remove) { " -Remove $Name" } else { " $dir $Name" })"
	if (-not $OpenListener) {
		Refuse-Private 'Storage' "$($env:AZURE_STORAGE_ACCOUNT).blob.core.windows.net" "./scripts/ingest.ps1$flags" "./scripts/ingest.ps1 -OpenListener$flags"
	}
	# The listener alone is not the way in: the account's firewall denies by
	# default. One rule lets this machine's public address through, and the
	# default is left as it is, so the open listener admits nobody else.
	Find-OwnAddress
	if (-not $Ip) { throw "ingest: $ipLookup did not say this machine's public IPv4 address; pass it with -Ip <address>" }
	# A rule the account already holds for the address is its operator's, and stays.
	$rules = @(az storage account network-rule list @firewall --query 'ipRules[].ipAddressOrRange' -o tsv | Where-Object { $_ })
	if ($LASTEXITCODE -ne 0) { throw "ingest: could not read the firewall rules of $($env:AZURE_STORAGE_ACCOUNT)" }
	$opening = $true
	# A signal that would end the process is caught and remembered, so the
	# run stops at its next step and closes what it opened on the way out: a
	# `finally` alone is not run for a terminal that closed or a termination
	# that was asked for. The handler is compiled code, because a script
	# block has no runspace on the thread a signal arrives on.
	Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IngestSignals {
	public static volatile string Caught;
	static PosixSignalRegistration[] held = Array.Empty<PosixSignalRegistration>();
	public static void Watch() {
		Action<PosixSignalContext> remember = context => { context.Cancel = true; Caught = context.Signal.ToString(); };
		held = new[] {
			PosixSignalRegistration.Create(PosixSignal.SIGTERM, remember),
			PosixSignalRegistration.Create(PosixSignal.SIGHUP, remember),
		};
	}
	public static void Release() {
		foreach (var registration in held) registration.Dispose();
		held = Array.Empty<PosixSignalRegistration>();
	}
}
'@
	[IngestSignals]::Watch()
}
# Stops the run at a step's edge once a signal has asked it to end.
function Stop-IfSignalled {
	if ($opening -and [IngestSignals]::Caught) { throw "ingest: stopped by $([IngestSignals]::Caught)" }
}
try {
if ($opening) {
	$admitted = $Ip
	$mine = $rules -cnotcontains $Ip
	# Tagged before either call, on the account and here: a change that landed
	# behind a failed answer, or before a kill, is still there to be taken back.
	$run = ([guid]::NewGuid().ToString('N')).Substring(0, 8)
	$tag = "${run}:${Ip}:$(if ($mine) { 'listener+rule' } else { 'listener' }):$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
	if (-not (Set-AccountTag 'Merge' $tag)) { $tag = ''; throw "ingest: could not tag $($env:AZURE_STORAGE_ACCOUNT) as open, so nothing was opened" }
	$ruled = $mine
	$opened = $true
	az storage account update @account --public-network-access Enabled -o none
	if ($LASTEXITCODE -ne 0) { throw "ingest: could not open the listener of $($env:AZURE_STORAGE_ACCOUNT)" }
	if ($ruled) {
		az storage account network-rule add @firewall --ip-address $Ip -o none
		if ($LASTEXITCODE -ne 0) { throw "ingest: could not let $Ip through the firewall of $($env:AZURE_STORAGE_ACCOUNT)" }
	}
	Write-Host "ingest: $($env:AZURE_STORAGE_ACCOUNT)'s public listener is on for the mirror, for $Ip alone; it is off again before the job runs, or when this exits"
	# The account answers the change before its data plane follows it. How
	# long a firewall rule takes to apply is known only from the service's
	# behaviour, so the container is asked until it answers, for two minutes
	# at most.
	$reachable = $false
	foreach ($try in 1..24) {
		az storage container show @store -n $container -o none 2>$null
		if ($LASTEXITCODE -eq 0) { $reachable = $true; break }
		Stop-IfSignalled
		Start-Sleep -Seconds 5
	}
	if (-not $reachable) { throw "ingest: $($env:AZURE_STORAGE_ACCOUNT) did not become reachable within two minutes of opening its listener for $Ip. If az leaves this machine by another address (a proxy, a split tunnel), name that one with -Ip <address>" }
}

# Plain az data-plane calls under your sign-in, rather than `az storage blob
# sync`, which fetches AzCopy on first use. A listing that fails stops the
# script before anything is uploaded or deleted. Each blob comes with the MD5
# the service computed when it was uploaded in one request.
$listing = @(az storage blob list @store -c $container --prefix "$Name/" --num-results '*' --query '[].[name, properties.contentSettings.contentMd5]' -o tsv | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { throw "ingest: could not list $container/$Name/" }
Stop-IfSignalled
# Blob names are case-sensitive, so the table that holds them is too.
$held = [Collections.Hashtable]::new([StringComparer]::Ordinal)
foreach ($line in $listing) {
	$blob, $md5 = $line -split "`t", 2
	$held[$blob] = $md5
}
$changed = @()
if ($Remove) {
	$gone = @($held.Keys | Sort-Object -CaseSensitive)
} else {
	$kept = [Collections.Generic.HashSet[string]]::new([string[]]@($files | ForEach-Object { "$Name/$_" }))
	$gone = @($held.Keys | Where-Object { -not $kept.Contains($_) } | Sort-Object -CaseSensitive)
	# A file whose bytes its blob already holds is not sent again: the
	# indexer reads what changed, and an upload is a change to it.
	$changed = @($files | Where-Object {
		$md5 = [Convert]::ToBase64String([Security.Cryptography.MD5]::HashData([IO.File]::ReadAllBytes((Join-Path $dir $_))))
		$held["$Name/$_"] -ne $md5
	})
}

if ($DryRun) {
	if (-not $Remove) {
		foreach ($rel in $changed) { Write-Host "ingest: would upload $dir/$rel to $container/$Name/$rel" }
		Write-Host "ingest: would upload $($changed.Count) changed file(s) from $dir to $container/$Name/"
	}
	foreach ($blob in $gone) { Write-Host "ingest: would delete $container/$blob" }
	Write-Host 'ingest: dry run — nothing was uploaded or deleted, and the job did not run'
	return
}

if ($Remove) {
	az storage blob delete-batch @store --source $container --pattern "$Name/*" --delete-snapshots include -o none
	if ($LASTEXITCODE -ne 0) { throw "ingest: could not delete $container/$Name/" }
	Write-Host "ingest: $container/$Name/ deleted"
} else {
	if ($changed.Count -gt 0) {
		# The changed files alone, at their paths, so one upload sends them.
		$staged = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
		try {
			foreach ($rel in $changed) {
				$target = Join-Path $staged $rel
				[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
				Copy-Item -LiteralPath (Join-Path $dir $rel) -Destination $target
			}
			Stop-IfSignalled
			az storage blob upload-batch @store `
				--destination $container --destination-path $Name --source $staged --overwrite -o none
			if ($LASTEXITCODE -ne 0) { throw "ingest: the upload failed" }
		} finally {
			Remove-Item -Recurse -Force -LiteralPath $staged -ErrorAction SilentlyContinue
		}
		Stop-IfSignalled
		Write-Host "ingest: $($changed.Count) changed file(s) of $dir uploaded to $container/$Name/"
	} else {
		Write-Host "ingest: $container/$Name/ already holds every file of $dir"
	}
	foreach ($blob in $gone) {
		Stop-IfSignalled
		az storage blob delete @store -c $container -n $blob --delete-snapshots include -o none
		if ($LASTEXITCODE -ne 0) { throw "ingest: could not delete $container/$blob" }
		Write-Host "ingest: deleted $container/$blob, which $dir no longer has"
	}
}

} finally {
	# The mirror is over, or failed: the job reads the account from inside the network.
	if (($opened -or $ruled) -and -not $unclosed) { Close-Listener }
}
if ($opening) {
	# The account is closed: a signal ends the run as it ends any other from here.
	[IngestSignals]::Release()
	Stop-IfSignalled
}

# The job rests on the deploy's steps; it goes back to them however this ends.
$step = if ($Remove) { "remove-library:$Name" } else { "library:$Name" }
try {
	Update-MigrateJob --args src/job.ts $step
	Invoke-MigrateJob $step
	# Readers the load recorded and nothing enforces are said here, not left in the job's log.
	if (-not $Remove) { Show-UnenforcedReaders $step }
} finally {
	$steps = Get-DeploySteps
	Update-MigrateJob --args @steps
}
