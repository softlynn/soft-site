param(
  [string]$SourcePng = (Join-Path $PSScriptRoot "..\desktop\softuchive\assets\icon.png"),
  [string]$OutputIco = (Join-Path $PSScriptRoot "..\desktop\softuchive\assets\icon.ico")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sourcePath = [System.IO.Path]::GetFullPath($SourcePng)
$outputPath = [System.IO.Path]::GetFullPath($OutputIco)

if (!(Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Softuchive PNG icon was not found at $sourcePath"
}

New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($outputPath)) -Force | Out-Null

$source = [System.Drawing.Image]::FromFile($sourcePath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = New-Object System.Collections.Generic.List[object]

try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $size, $size)

      $memory = New-Object System.IO.MemoryStream
      $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
      $frames.Add([PSCustomObject]@{
        Size = $size
        Bytes = $memory.ToArray()
      })
      $memory.Dispose()
    }
    finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
}
finally {
  $source.Dispose()
}

$stream = [System.IO.File]::Create($outputPath)
$writer = New-Object System.IO.BinaryWriter($stream)
try {
  # ICO directory header: reserved, image type, number of frames.
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$frames.Count)

  $offset = 6 + (16 * $frames.Count)
  foreach ($frame in $frames) {
    $dimension = if ($frame.Size -eq 256) { [byte]0 } else { [byte]$frame.Size }
    $writer.Write($dimension)
    $writer.Write($dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$frame.Bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $frame.Bytes.Length
  }

  foreach ($frame in $frames) {
    $writer.Write($frame.Bytes)
  }
}
finally {
  $writer.Dispose()
  $stream.Dispose()
}

Write-Host "Generated $outputPath with $($sizes.Count) PNG-backed icon sizes from $sourcePath"
