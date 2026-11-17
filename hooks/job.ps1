# Dot-sourced by postdeploy and the ingest script: the migrate job, which runs
# the backend image beside the apps, in their network, as its own identity,
# so every write into a data plane happens there and a deployer needs only az.
#
#   Assert-Subscription <who>      throws, from <who>, unless the environment
#                                 names its subscription
#   Get-DeploySteps               the job's arguments for a deploy, which are
#                                 also what it rests on (as the template sets them)
#   Update-MigrateJob <flag>...   az containerapp job update with these flags;
#                                 `--args` keeps the job's environment and
#                                 identity, where `job start --args` would
#                                 replace the container with it
#   Invoke-MigrateJob <label>     start one execution, wait for it, print its
#                                 log's last 200 lines (az's own default is the
#                                 last ~20) and throw if it did not succeed. A
#                                 status that cannot be read is asked again;
#                                 five in a row end the wait, naming the
#                                 execution, which may still be running. The
#                                 execution's name is left in
#                                 $script:MigrateJobExecution
#   Show-UnenforcedReaders <label> after a library load that succeeded: the
#                                 lines of the execution's log that say
#                                 readers are recorded and not enforced
#                                 (access.enforceAccessControl off), repeated
#                                 where the operator sees them. A log that
#                                 cannot be read says nothing; the load stands
#
# Every az call names the environment's subscription: az's default is
# whichever one was selected last on this machine, and a job looked for
# there "does not exist".

function Assert-Subscription([string]$Who) {
	if (-not $env:AZURE_SUBSCRIPTION_ID) { throw "${Who}: AZURE_SUBSCRIPTION_ID is not in the azd environment; run azd up first" }
}

function Get-DeploySteps {
	$sample = if ("$env:SEED_SAMPLE_LIBRARY".ToLowerInvariant() -eq 'false') { 'remove-library' } else { 'library' }
	return @('src/job.ts', 'settings', 'index', 'skills', 'agent', $sample)
}

function Update-MigrateJob {
	az containerapp job update --subscription $env:AZURE_SUBSCRIPTION_ID -g $env:AZURE_RESOURCE_GROUP -n $env:MIGRATE_JOB_NAME @args -o none
	if ($LASTEXITCODE -ne 0) { throw "could not update the job: $args" }
}

function Invoke-MigrateJob([string]$Label) {
	$execution = az containerapp job start --subscription $env:AZURE_SUBSCRIPTION_ID -g $env:AZURE_RESOURCE_GROUP -n $env:MIGRATE_JOB_NAME --query name -o tsv
	if ($LASTEXITCODE -ne 0) { throw "${Label}: the job did not start" }
	$script:MigrateJobExecution = $execution
	Write-Host "${Label}: started $execution"
	$unread = 0
	for ($i = 0; $i -lt 180; $i++) {
		$status = az containerapp job execution show --subscription $env:AZURE_SUBSCRIPTION_ID -g $env:AZURE_RESOURCE_GROUP -n $env:MIGRATE_JOB_NAME --job-execution-name $execution --query properties.status -o tsv
		if ($LASTEXITCODE -eq 0) { $unread = 0 } else {
			$unread++
			if ($unread -ge 5) { throw "${Label}: the status of $execution could not be read five times in a row; it may still be running" }
		}
		switch ($status) {
			'Succeeded' { Write-Host "${Label}: $execution succeeded"; return }
			{ $_ -in 'Failed', 'Stopped', 'Degraded' } {
				az containerapp job logs show --subscription $env:AZURE_SUBSCRIPTION_ID -g $env:AZURE_RESOURCE_GROUP -n $env:MIGRATE_JOB_NAME --execution $execution --container migrate --tail 200
				throw "${Label}: $execution ended $status"
			}
		}
		Start-Sleep -Seconds 10
	}
	throw "${Label}: $execution still running after thirty minutes"
}

# The job's own words: platform/knowledge's UNENFORCED_READERS, which ingest.test.ts holds this to.
$UnenforcedMark = 'WARNING: READERS NOT ENFORCED'
function Show-UnenforcedReaders([string]$Label) {
	$log = az containerapp job logs show --subscription $env:AZURE_SUBSCRIPTION_ID -g $env:AZURE_RESOURCE_GROUP -n $env:MIGRATE_JOB_NAME --execution $script:MigrateJobExecution --container migrate --tail 200 2>$null
	if ($LASTEXITCODE -ne 0) { return }
	$said = @($log | Where-Object { "$_".Contains($UnenforcedMark) })
	if ($said.Count -eq 0) { return }
	[Console]::Error.WriteLine('')
	[Console]::Error.WriteLine("${Label}: $UnenforcedMark. The library names readers and access control is off, so every signed-in person can find and read all of it until access.enforceAccessControl is on (docs/documents.md, `"Who may read a document`"). The job said:")
	foreach ($line in $said) { [Console]::Error.WriteLine($line) }
	[Console]::Error.WriteLine('')
}
