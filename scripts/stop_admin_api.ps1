param()

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$adminApiScript = Join-Path $scriptDir "run_local_admin_api.mjs"
$adminApiRegex = [Regex]::Escape($adminApiScript)

$adminApiProcesses = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match $adminApiRegex }

foreach ($proc in $adminApiProcesses) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Stopped local admin API process(es)."
