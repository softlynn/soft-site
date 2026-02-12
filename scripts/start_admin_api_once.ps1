param()

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$adminApiScript = Join-Path $scriptDir "run_local_admin_api.mjs"
$envFilePath = Join-Path $repoRoot ".env.local"
$logDir = Join-Path $scriptDir ".state"
$stdoutLog = Join-Path $logDir "admin-api-stdout.log"
$stderrLog = Join-Path $logDir "admin-api-stderr.log"
$port = 49731

if (!(Test-Path $adminApiScript)) {
  exit 0
}

if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

if (Test-Path $envFilePath) {
  try {
    $envLines = Get-Content -Path $envFilePath -ErrorAction Stop
    foreach ($line in $envLines) {
      if ($line -match '^\s*ADMIN_API_PORT\s*=\s*(.+)\s*$') {
        $rawPort = ($matches[1] -replace '\s+', '').Trim('"').Trim("'")
        $parsedPort = 0
        if ([int]::TryParse($rawPort, [ref]$parsedPort) -and $parsedPort -gt 0) {
          $port = $parsedPort
        }
        break
      }
    }
  } catch {
    # Continue with default fallback.
  }
}

$isListening = $false
try {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -First 1
  if ($listener) {
    $isListening = $true
  }
} catch {
  $isListening = $false
}

if ($isListening) {
  exit 0
}

$scriptRegex = [Regex]::Escape($adminApiScript)
$staleNodeProcesses = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match $scriptRegex }
foreach ($proc in $staleNodeProcesses) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

try {
  Start-Process -FilePath "node" `
    -ArgumentList @($adminApiScript) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null
} catch {
  $timestamp = Get-Date -Format o
  "[$timestamp] Failed to launch local admin API: $($_.Exception.Message)" | Out-File -FilePath $stderrLog -Append -Encoding utf8
}
