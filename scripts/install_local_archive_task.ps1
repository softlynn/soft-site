param(
  [string]$TaskName = "SoftArchivePipeline",
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$runnerPath = Join-Path $PSScriptRoot "run_local_archive_task_once.ps1"
$launcherPath = Join-Path $PSScriptRoot "run_archive_task_hidden.vbs"

if (!(Test-Path $runnerPath)) {
  throw "Missing archive task runner at '$runnerPath'."
}

if (!(Test-Path $launcherPath)) {
  throw "Missing archive task hidden launcher at '$launcherPath'."
}

$taskCommand = "wscript.exe //B //Nologo `"$launcherPath`""

schtasks /Create /TN $TaskName /TR $taskCommand /SC MINUTE /MO $EveryMinutes /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create scheduled task '$TaskName'."
}

Write-Host "Installed scheduled task '$TaskName' to run every $EveryMinutes minutes (hidden launcher)."
