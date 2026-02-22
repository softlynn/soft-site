param(
  [string]$SourceDir = "twitch-extension/softu-vods-panel",
  [string]$OutDir = "twitch-extension/dist",
  [string]$ZipName = "softu-vods-panel.zip"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $repoRoot $SourceDir
$destDirPath = Join-Path $repoRoot $OutDir
$zipPath = Join-Path $destDirPath $ZipName

if (-not (Test-Path $srcPath)) {
  throw "Source directory not found: $srcPath"
}

if (-not (Test-Path $destDirPath)) {
  New-Item -ItemType Directory -Path $destDirPath | Out-Null
}

if (Test-Path $zipPath) {
  Remove-Item -Force $zipPath
}

# Twitch expects the extension files at the zip root (not nested under the folder).
Compress-Archive -Path (Join-Path $srcPath "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Created:" $zipPath
