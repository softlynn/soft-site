param(
  [string]$OutputPath = (Join-Path $PSScriptRoot "tools\TwitchDownloaderCLI.exe")
)

$ErrorActionPreference = "Stop"

$outputDir = Split-Path -Parent $OutputPath
if (!(Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

if (Test-Path $OutputPath) {
  Write-Host "TwitchDownloaderCLI already installed at $OutputPath"
  exit 0
}

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/lay295/TwitchDownloader/releases/latest"
$asset = $release.assets | Where-Object { $_.name -like "TwitchDownloaderCLI-*-Windows-x64.zip" } | Select-Object -First 1

if (-not $asset) {
  throw "Unable to locate TwitchDownloader Windows x64 asset."
}

$zipPath = Join-Path $outputDir "twitchdownloader.zip"
$extractDir = Join-Path $outputDir "twitchdownloader-extract"

Write-Host "Downloading TwitchDownloaderCLI from $($asset.browser_download_url)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath

if (Test-Path $extractDir) {
  Remove-Item $extractDir -Recurse -Force
}

Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$exe = Get-ChildItem -Path $extractDir -Recurse -Filter "TwitchDownloaderCLI.exe" | Select-Object -First 1
if (-not $exe) {
  throw "Failed to locate TwitchDownloaderCLI.exe after extraction."
}

Copy-Item -Path $exe.FullName -Destination $OutputPath -Force
Write-Host "Installed TwitchDownloaderCLI to $OutputPath"
