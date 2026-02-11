param(
  [string]$TaskName = "SoftArchiveAdminApi"
)

$ErrorActionPreference = "Stop"

$startupCmdPath = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup") "soft-admin-api.cmd"
$taskRemoved = $false

schtasks /Delete /TN $TaskName /F | Out-Null
if ($LASTEXITCODE -eq 0) {
  $taskRemoved = $true
}

if (Test-Path $startupCmdPath) {
  Remove-Item -Path $startupCmdPath -Force
  Write-Host "Removed Startup launcher '$startupCmdPath'."
}

if ($taskRemoved) {
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' was not found."
}
