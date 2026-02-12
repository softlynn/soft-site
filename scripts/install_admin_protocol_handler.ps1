param(
  [string]$ProtocolName = "soft-archive-admin"
)

$ErrorActionPreference = "Stop"

$starterScriptPath = Join-Path $PSScriptRoot "start_admin_api_once.ps1"
if (!(Test-Path $starterScriptPath)) {
  throw "Missing starter script at '$starterScriptPath'."
}

$protocolRoot = "HKCU:\Software\Classes\$ProtocolName"
$commandKey = Join-Path $protocolRoot "shell\open\command"
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$starterScriptPath`""

New-Item -Path $protocolRoot -Force | Out-Null
Set-Item -Path $protocolRoot -Value "URL:Soft Archive Admin Protocol" | Out-Null
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -PropertyType String -Value "" -Force | Out-Null
New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $commandKey -Value $command | Out-Null

Write-Host "Installed protocol handler '${ProtocolName}://'."
