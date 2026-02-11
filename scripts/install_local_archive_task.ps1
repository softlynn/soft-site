param(
  [string]$TaskName = "SoftArchivePipeline",
  [int]$EveryMinutes = 15
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "run_local_archive_pipeline.mjs"
$workingDir = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot ".state\archive-task.log"

if (!(Test-Path (Split-Path -Parent $logPath))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
}

$taskCommand = "cmd /c cd /d `"$workingDir`" && node `"$scriptPath`" >> `"$logPath`" 2>&1"

schtasks /Create /TN $TaskName /TR $taskCommand /SC MINUTE /MO $EveryMinutes /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create scheduled task '$TaskName'."
}

Write-Host "Installed scheduled task '$TaskName' to run every $EveryMinutes minutes."
