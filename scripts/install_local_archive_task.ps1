param(
  [string]$TaskName = "SoftArchivePipeline",
  [int]$EveryMinutes = 15
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$runnerPath = Join-Path $PSScriptRoot "run_local_archive_task_once.ps1"

if (!(Test-Path $runnerPath)) {
  throw "Missing archive task runner at '$runnerPath'."
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`""

schtasks /Create /TN $TaskName /TR $taskCommand /SC MINUTE /MO $EveryMinutes /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create scheduled task '$TaskName'."
}

Write-Host "Installed scheduled task '$TaskName' to run every $EveryMinutes minutes."
