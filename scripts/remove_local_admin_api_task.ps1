param(
  [string]$TaskName = "SoftArchiveAdminApi"
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$legacyTaskNames = @("SoftArchiveAdminApiStarter")
$starterPsPath = Join-Path $PSScriptRoot "start_admin_api_once.ps1"
$watchdogPsPath = Join-Path $PSScriptRoot "start_admin_api_watchdog.ps1"
$adminApiScriptPath = Join-Path $PSScriptRoot "run_local_admin_api.mjs"
$startupCmdPath = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup") "soft-admin-api.cmd"
$startupVbsPath = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup") "soft-admin-api.vbs"

$allTaskNames = @($TaskName) + $legacyTaskNames | Select-Object -Unique
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
foreach ($name in $allTaskNames) {
  schtasks /Delete /TN $name /F 2>$null | Out-Null
}
$ErrorActionPreference = $previousErrorActionPreference

if (Test-Path $startupCmdPath) {
  Remove-Item -Path $startupCmdPath -Force
  Write-Host "Removed Startup launcher '$startupCmdPath'."
}

if (Test-Path $startupVbsPath) {
  Remove-Item -Path $startupVbsPath -Force
  Write-Host "Removed Startup launcher '$startupVbsPath'."
}

$starterRegex = [Regex]::Escape($starterPsPath)
$watchdogRegex = [Regex]::Escape($watchdogPsPath)
$adminApiRegex = [Regex]::Escape($adminApiScriptPath)

$powershellProcesses = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "powershell.exe" -and ($_.CommandLine -match $starterRegex -or $_.CommandLine -match $watchdogRegex -or $_.CommandLine -match $adminApiRegex) }
foreach ($proc in $powershellProcesses) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

$adminApiProcesses = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match $adminApiRegex }
foreach ($proc in $adminApiProcesses) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Removed local admin API auto-start hooks and stopped related processes."
