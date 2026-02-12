param(
  [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = "Continue"
$mutexName = "Local\SoftArchiveAdminApiWatchdogMutex"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
  # Another watchdog instance is already running.
  exit 0
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$adminApiScript = Join-Path $scriptDir "run_local_admin_api.mjs"
$logPath = Join-Path $scriptDir ".state\admin-api.log"
$logDir = Split-Path -Parent $logPath

if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

try {
  while ($true) {
    try {
      Push-Location $repoRoot
      & node $adminApiScript *>> $logPath
    } catch {
      "[$(Get-Date -Format o)] Watchdog launch error: $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8
    } finally {
      Pop-Location
    }

    Start-Sleep -Seconds $RestartDelaySeconds
  }
} finally {
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}
