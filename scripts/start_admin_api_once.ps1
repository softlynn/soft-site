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
$host = "127.0.0.1"
$fallbackPort = 49721

function Test-AdminApiHealth {
  param(
    [string]$ApiHost,
    [int]$ApiPort
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://{0}:{1}/health" -f $ApiHost, $ApiPort) -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $false }
    $payload = $null
    try {
      $payload = $response.Content | ConvertFrom-Json
    } catch {
      return $false
    }
    return ($payload -and $payload.ok -eq $true -and [string]$payload.service -eq "soft-admin-api")
  } catch {
    return $false
  }
}

function Test-PortListening {
  param([int]$ApiPort)
  try {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $ApiPort -ErrorAction Stop | Select-Object -First 1
    return $null -ne $listener
  } catch {
    return $false
  }
}

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
      if ($line -match '^\s*ADMIN_API_HOST\s*=\s*(.+)\s*$') {
        $parsedHost = [string](($matches[1] -replace '\s+', '').Trim('"').Trim("'"))
        if ($parsedHost) {
          $host = $parsedHost
        }
      }
    }
  } catch {
    # Continue with default fallback.
  }
}

if (Test-AdminApiHealth -ApiHost $host -ApiPort $port) {
  exit 0
}
if ($fallbackPort -ne $port -and (Test-AdminApiHealth -ApiHost $host -ApiPort $fallbackPort)) {
  exit 0
}

$candidatePorts = @($port, $fallbackPort) | Select-Object -Unique
$launchPort = $null
foreach ($candidatePort in $candidatePorts) {
  if (!(Test-PortListening -ApiPort $candidatePort)) {
    $launchPort = [int]$candidatePort
    break
  }
}

if ($null -eq $launchPort) {
  $timestamp = Get-Date -Format o
  "[$timestamp] Failed to launch local admin API: no free candidate port ($($candidatePorts -join ', '))." | Out-File -FilePath $stderrLog -Append -Encoding utf8
  exit 0
}

$scriptRegex = [Regex]::Escape($adminApiScript)
$staleNodeProcesses = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -ieq "node.exe" -and $_.CommandLine -match $scriptRegex }
foreach ($proc in $staleNodeProcesses) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

try {
  $previousAdminApiPort = $env:ADMIN_API_PORT
  $env:ADMIN_API_PORT = [string]$launchPort
  Start-Process -FilePath "node" `
    -ArgumentList @($adminApiScript) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null
} catch {
  $timestamp = Get-Date -Format o
  "[$timestamp] Failed to launch local admin API: $($_.Exception.Message)" | Out-File -FilePath $stderrLog -Append -Encoding utf8
} finally {
  if ($null -eq $previousAdminApiPort) {
    Remove-Item Env:\ADMIN_API_PORT -ErrorAction SilentlyContinue
  } else {
    $env:ADMIN_API_PORT = $previousAdminApiPort
  }
}
