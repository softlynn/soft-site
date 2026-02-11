param(
  [string]$TaskName = "SoftArchivePipeline"
)

$ErrorActionPreference = "Stop"

schtasks /Delete /TN $TaskName /F | Out-Null
Write-Host "Removed scheduled task '$TaskName'."
