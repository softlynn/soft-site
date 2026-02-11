param(
  [string]$TaskName = "SoftArchiveAdminApi"
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$scriptPath = Join-Path $PSScriptRoot "run_local_admin_api.mjs"
$workingDir = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot ".state\admin-api.log"
$watchdogPsPath = Join-Path $PSScriptRoot "start_admin_api_watchdog.ps1"

if (!(Test-Path (Split-Path -Parent $logPath))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
}

$taskCommand = "cmd /c cd /d `"$workingDir`" && node `"$scriptPath`" >> `"$logPath`" 2>&1"

$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$startupCmdPath = Join-Path $startupDir "soft-admin-api.cmd"
$startupVbsPath = Join-Path $startupDir "soft-admin-api.vbs"
$watchdogCmdPath = Join-Path $PSScriptRoot "start_admin_api_watchdog.cmd"
$usedScheduledTask = $false

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
schtasks /Create /TN $TaskName /TR $taskCommand /SC ONLOGON /F 2>$null | Out-Null
$ErrorActionPreference = $previousErrorActionPreference
if ($LASTEXITCODE -eq 0) {
  $usedScheduledTask = $true
} else {
  Write-Host "Scheduled task creation failed; falling back to Startup folder launcher."
  if (!(Test-Path $startupDir)) {
    New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
  }

  if (Test-Path $startupCmdPath) {
    Remove-Item -Path $startupCmdPath -Force
  }
  if (Test-Path $watchdogCmdPath) {
    Remove-Item -Path $watchdogCmdPath -Force
  }

  @"
Set WShell = CreateObject("WScript.Shell")
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$watchdogPsPath"""
WShell.Run cmd, 0, False
"@ | Set-Content -Path $startupVbsPath -Encoding ascii
}

if ($usedScheduledTask) {
  schtasks /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start scheduled task '$TaskName'."
  }
  Write-Host "Installed and started scheduled task '$TaskName'."
} else {
  Start-Process -FilePath "wscript.exe" -ArgumentList "`"$startupVbsPath`"" -WindowStyle Hidden
  Write-Host "Installed Startup launcher at '$startupVbsPath' and started admin API."
}
