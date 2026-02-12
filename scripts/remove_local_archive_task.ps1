param(
  [string]$TaskName = "SoftArchivePipeline"
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
$ErrorActionPreference = $previousErrorActionPreference

if ($LASTEXITCODE -eq 0) {
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' was not found."
}

$pipelineRegex = [Regex]::Escape((Join-Path $PSScriptRoot "run_local_archive_pipeline.mjs"))
$runnerRegex = [Regex]::Escape((Join-Path $PSScriptRoot "run_local_archive_task_once.ps1"))

$nodeProcs = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match $pipelineRegex }
foreach ($proc in $nodeProcs) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

$powershellProcs = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "powershell.exe" -and $_.CommandLine -match $runnerRegex }
foreach ($proc in $powershellProcs) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Stopped local archive pipeline task processes."
