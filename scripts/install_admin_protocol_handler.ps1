param(
  [string]$ProtocolName = "soft-archive-admin"
)

$ErrorActionPreference = "Stop"

$launcherVbsPath = Join-Path $PSScriptRoot "wake_admin_api.vbs"
if (!(Test-Path $launcherVbsPath)) {
  throw "Missing launcher script at '$launcherVbsPath'."
}

$protocolRoot = "HKCU:\Software\Classes\$ProtocolName"
$commandKey = Join-Path $protocolRoot "shell\open\command"
$command = "wscript.exe //B //Nologo `"$launcherVbsPath`""

New-Item -Path $protocolRoot -Force | Out-Null
Set-Item -Path $protocolRoot -Value "URL:Soft Archive Admin Protocol" | Out-Null
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -PropertyType String -Value "" -Force | Out-Null
New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $commandKey -Value $command | Out-Null

Write-Host "Installed protocol handler '${ProtocolName}://'."
