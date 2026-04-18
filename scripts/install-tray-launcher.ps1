param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$PluginRoot = (Join-Path $HOME ".codex\\plugins\\codex-wechat-bridge"),
  [string]$ShortcutName = "WeChat Bridge.lnk"
)

$ErrorActionPreference = "Stop"

function Resolve-CscPath {
  $candidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  throw "Cannot find csc.exe from .NET Framework."
}

$sourcePath = (Resolve-Path (Join-Path $RepoRoot "scripts\\tray-launcher.cs")).Path
$resolvedPluginRoot =
  if (Test-Path $PluginRoot) {
    (Resolve-Path $PluginRoot).Path
  } else {
    $RepoRoot
  }

$sourceTrayScript = Join-Path $RepoRoot "scripts\\wechat-bridge-tray.ps1"
$targetTrayScript = Join-Path $resolvedPluginRoot "scripts\\wechat-bridge-tray.ps1"
$targetScriptsDir = Split-Path -Parent $targetTrayScript
New-Item -ItemType Directory -Force -Path $targetScriptsDir | Out-Null
Copy-Item -LiteralPath $sourceTrayScript -Destination $targetTrayScript -Force

$outputDir = Join-Path $resolvedPluginRoot "artifacts\\launcher"
$buildDir = Join-Path ([System.IO.Path]::GetTempPath()) "codex-wechat-bridge-tray-build"
$buildExePath = Join-Path $buildDir "WeChat Bridge Tray.exe"
$exePath = Join-Path $outputDir "WeChat Bridge Tray.exe"
$desktopDir = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopDir $ShortcutName
$desktopIconPath = (Resolve-Path (Join-Path $resolvedPluginRoot "assets\\desktop\\codex_wechat_desktop_round.ico")).Path

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$csc = Resolve-CscPath
$cscArguments = @(
  "/nologo",
  "/target:winexe",
  "/out:$buildExePath",
  "/win32icon:$desktopIconPath",
  "/reference:System.dll",
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  $sourcePath
)

& $csc @cscArguments

if ($LASTEXITCODE -ne 0) {
  throw "csc.exe failed to build the tray launcher."
}

Copy-Item -LiteralPath $buildExePath -Destination $exePath -Force

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $resolvedPluginRoot
$shortcut.Description = "Launch the Codex WeChat Bridge tray"
$shortcut.Save()

# Persist the desktop-facing icon explicitly after the launcher target has been written.
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.IconLocation = "$desktopIconPath,0"
$shortcut.Save()

Write-Host "Tray launcher executable: $exePath"
Write-Host "Desktop shortcut created: $shortcutPath"
Write-Host "Tray runtime root: $resolvedPluginRoot"
