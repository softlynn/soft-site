param(
  [string]$TaskName = "SoftArchiveAdminApi"
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$legacyTaskNames = @("SoftArchiveAdminApiStarter")
$starterPsPath = Join-Path $PSScriptRoot "start_admin_api_once.ps1"
$adminApiScriptPath = Join-Path $PSScriptRoot "run_local_admin_api.mjs"
$watchdogPsPath = Join-Path $PSScriptRoot "start_admin_api_watchdog.ps1"
$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$startupCmdPath = Join-Path $startupDir "soft-admin-api.cmd"
$startupVbsPath = Join-Path $startupDir "soft-admin-api.vbs"

if (!(Test-Path $starterPsPath)) {
  throw "Missing admin API starter script at '$starterPsPath'."
}

if (!(Test-Path $startupDir)) {
  New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
}

$allTaskNames = @($TaskName) + $legacyTaskNames | Select-Object -Unique
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
foreach ($name in $allTaskNames) {
  schtasks /Delete /TN $name /F 2>$null | Out-Null
}
$ErrorActionPreference = $previousErrorActionPreference

$adminApiRegex = [Regex]::Escape($adminApiScriptPath)
$watchdogRegex = [Regex]::Escape($watchdogPsPath)
$powershellProcesses = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "powershell.exe" -and ($_.CommandLine -match $watchdogRegex -or $_.CommandLine -match $adminApiRegex) }
foreach ($proc in $powershellProcesses) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

$adminApiProcesses = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match $adminApiRegex }
foreach ($proc in $adminApiProcesses) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path $startupCmdPath) {
  Remove-Item -Path $startupCmdPath -Force
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$starterPsPath`""
$usedScheduledTask = $false

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
schtasks /Create /TN $TaskName /TR $taskCommand /SC ONLOGON /F 2>$null | Out-Null
$ErrorActionPreference = $previousErrorActionPreference
if ($LASTEXITCODE -eq 0) {
  $usedScheduledTask = $true
}

if ($usedScheduledTask) {
  if (Test-Path $startupVbsPath) {
    Remove-Item -Path $startupVbsPath -Force
  }

  schtasks /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start scheduled task '$TaskName'."
  }

  Write-Host "Installed and started scheduled task '$TaskName' (one-shot starter on login)."
  exit 0
}

Write-Host "Scheduled task creation failed; using Startup folder launcher."
@"
Set WShell = CreateObject("WScript.Shell")
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$starterPsPath"""
WShell.Run cmd, 0, False
"@ | Set-Content -Path $startupVbsPath -Encoding ascii

Start-Process -FilePath "wscript.exe" -ArgumentList "`"$startupVbsPath`"" -WindowStyle Hidden
Write-Host "Installed Startup launcher at '$startupVbsPath' and started admin API."
