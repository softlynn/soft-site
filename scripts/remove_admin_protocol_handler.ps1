param(
  [string]$ProtocolName = "soft-archive-admin"
)

$ErrorActionPreference = "Continue"

$protocolRoot = "HKCU:\Software\Classes\$ProtocolName"
if (Test-Path $protocolRoot) {
  Remove-Item -Path $protocolRoot -Recurse -Force
  Write-Host "Removed protocol handler '${ProtocolName}://'."
} else {
  Write-Host "Protocol handler '${ProtocolName}://' was not found."
}
