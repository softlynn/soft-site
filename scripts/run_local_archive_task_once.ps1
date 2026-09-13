param()

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$pipelineScript = Join-Path $scriptDir "run_local_archive_pipeline.mjs"
$logPath = Join-Path $scriptDir ".state\archive-task.log"
$logDir = Split-Path -Parent $logPath
$pipelineExitCode = 1
$locationPushed = $false

if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

try {
  Push-Location $repoRoot
  $locationPushed = $true
  & node $pipelineScript --trigger=scheduled *>> $logPath
  $pipelineExitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
  if ($pipelineExitCode -ne 0) {
    "[$(Get-Date -Format o)] Archive pipeline exited with code $pipelineExitCode." |
      Out-File -FilePath $logPath -Append -Encoding utf8
  }
} catch {
  "[$(Get-Date -Format o)] Archive launcher error: $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8
  $pipelineExitCode = 1
} finally {
  if ($locationPushed) {
    Pop-Location
  }
}

exit $pipelineExitCode
