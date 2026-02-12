param()

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$pipelineScript = Join-Path $scriptDir "run_local_archive_pipeline.mjs"
$logPath = Join-Path $scriptDir ".state\archive-task.log"
$logDir = Split-Path -Parent $logPath

if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

try {
  Push-Location $repoRoot
  & node $pipelineScript *>> $logPath
} catch {
  "[$(Get-Date -Format o)] Archive launcher error: $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8
} finally {
  Pop-Location
}
