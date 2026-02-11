param(
  [string]$TaskName = "SoftArchiveAdminApi"
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$startupCmdPath = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup") "soft-admin-api.cmd"
$startupVbsPath = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup") "soft-admin-api.vbs"
$watchdogCmdPath = Join-Path $PSScriptRoot "start_admin_api_watchdog.cmd"
$taskRemoved = $false

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
$ErrorActionPreference = $previousErrorActionPreference
if ($LASTEXITCODE -eq 0) {
  $taskRemoved = $true
}

if (Test-Path $startupCmdPath) {
  Remove-Item -Path $startupCmdPath -Force
  Write-Host "Removed Startup launcher '$startupCmdPath'."
}

if (Test-Path $startupVbsPath) {
  Remove-Item -Path $startupVbsPath -Force
  Write-Host "Removed Startup launcher '$startupVbsPath'."
}

if (Test-Path $watchdogCmdPath) {
  Remove-Item -Path $watchdogCmdPath -Force
  Write-Host "Removed watchdog launcher '$watchdogCmdPath'."
}

if ($taskRemoved) {
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' was not found."
}
