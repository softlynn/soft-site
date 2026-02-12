param(
  [string]$TaskName = "SoftArchiveAdminApi"
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$watchdogPsPath = Join-Path $PSScriptRoot "start_admin_api_watchdog.ps1"
$adminApiScriptPath = Join-Path $PSScriptRoot "run_local_admin_api.mjs"
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

$watchdogRegex = [Regex]::Escape($watchdogPsPath)
$adminApiRegex = [Regex]::Escape($adminApiScriptPath)

$watchdogs = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "powershell.exe" -and $_.CommandLine -match $watchdogRegex }
foreach ($proc in $watchdogs) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

$adminApis = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match $adminApiRegex }
foreach ($proc in $adminApis) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Stopped local admin API watchdog/admin processes."
