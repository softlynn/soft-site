param(
  [string]$TaskName = "SoftArchiveAdminApi"
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "run_local_admin_api.mjs"
$workingDir = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot ".state\admin-api.log"

if (!(Test-Path (Split-Path -Parent $logPath))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
}

$taskCommand = "cmd /c cd /d `"$workingDir`" && node `"$scriptPath`" >> `"$logPath`" 2>&1"

$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$startupCmdPath = Join-Path $startupDir "soft-admin-api.cmd"
$usedScheduledTask = $false

schtasks /Create /TN $TaskName /TR $taskCommand /SC ONLOGON /F | Out-Null
if ($LASTEXITCODE -eq 0) {
  $usedScheduledTask = $true
} else {
  Write-Host "Scheduled task creation failed; falling back to Startup folder launcher."
  if (!(Test-Path $startupDir)) {
    New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
  }
  "@echo off`r`ncd /d `"$workingDir`"`r`nnode `"$scriptPath`" >> `"$logPath`" 2>&1`r`n" | Set-Content -Path $startupCmdPath -Encoding ascii
}

if ($usedScheduledTask) {
  schtasks /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start scheduled task '$TaskName'."
  }
  Write-Host "Installed and started scheduled task '$TaskName'."
} else {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$startupCmdPath`"" -WindowStyle Hidden
  Write-Host "Installed Startup launcher at '$startupCmdPath' and started admin API."
}
