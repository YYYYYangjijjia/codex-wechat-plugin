param(
  [string]$PluginName = "codex-wechat-bridge",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pluginRoot = Join-Path $HOME ".codex\plugins"
$pluginTarget = Join-Path $pluginRoot $PluginName
$pluginCacheRoot = Join-Path $pluginRoot "cache\local-personal-plugins"
$pluginCacheTarget = Join-Path $pluginCacheRoot $PluginName
$tmpPluginRoot = Join-Path $HOME ".codex\.tmp\plugins\plugins"
$tmpPluginTarget = Join-Path $tmpPluginRoot $PluginName
$marketplaceDir = Join-Path $HOME ".agents\plugins"
$marketplacePath = Join-Path $marketplaceDir "marketplace.json"
$marketplaceSourcePath = "./.codex/plugins/$PluginName"
$copyDirectories = @(".codex-plugin", "assets", "skills", "dist")
$copyFiles = @(".mcp.json", "package.json", "scripts\\wechat-bridge-tray.ps1")
$cacheCopyDirectories = @(".codex-plugin", "assets", "skills", "dist", "node_modules", "scripts")
$cacheCopyFiles = @(".mcp.json", "package.json")

function Ensure-Directory([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function New-MarketplaceObject {
  return [pscustomobject]@{
    name = "local-personal-plugins"
    interface = [pscustomobject]@{
      displayName = "Local Personal Plugins"
    }
    plugins = @()
  }
}

function Copy-PluginPayload {
  param(
    [string]$SourceRoot,
    [string]$TargetRoot,
    [string[]]$Directories = $copyDirectories,
    [string[]]$Files = $copyFiles
  )

  foreach ($directory in $Directories) {
    $sourceDir = Join-Path $SourceRoot $directory
    if (-not (Test-Path $sourceDir)) {
      continue
    }

    $targetDir = Join-Path $TargetRoot $directory
    if (Test-Path $targetDir) {
      cmd /c rmdir /s /q "$targetDir" | Out-Null
    }
    Ensure-Directory (Split-Path -Parent $targetDir)
    robocopy $sourceDir $targetDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
      throw "robocopy failed while copying '$directory' (exit code $LASTEXITCODE)."
    }
  }

  foreach ($file in $Files) {
    $sourceFile = Join-Path $SourceRoot $file
    if (Test-Path $sourceFile) {
      $targetFile = Join-Path $TargetRoot $file
      Ensure-Directory (Split-Path -Parent $targetFile)
      Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
    }
  }
}

function Copy-CachePayload {
  param(
    [string]$SourceRoot,
    [string]$TargetRoot
  )

  foreach ($directory in $cacheCopyDirectories) {
    $sourceDir = Join-Path $SourceRoot $directory
    if (-not (Test-Path $sourceDir)) {
      continue
    }

    $targetDir = Join-Path $TargetRoot $directory
    if (Test-Path $targetDir) {
      Remove-Item -LiteralPath $targetDir -Recurse -Force
    }

    Ensure-Directory (Split-Path -Parent $targetDir)
    Copy-Item -LiteralPath $sourceDir -Destination $targetDir -Recurse -Force
  }

  foreach ($file in $cacheCopyFiles) {
    $sourceFile = Join-Path $SourceRoot $file
    if (-not (Test-Path $sourceFile)) {
      continue
    }

    $targetFile = Join-Path $TargetRoot $file
    Ensure-Directory (Split-Path -Parent $targetFile)
    Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
  }
}

function Read-PackageVersion([string]$PackagePath) {
  $raw = Get-Content -Raw $PackagePath | ConvertFrom-Json
  if (-not $raw.version) {
    throw "Missing version in $PackagePath"
  }

  return [string]$raw.version
}

Ensure-Directory $pluginRoot
Ensure-Directory $marketplaceDir
Ensure-Directory $pluginCacheRoot

if ((Test-Path $pluginTarget) -and -not $Force) {
  Write-Host "Replacing existing plugin payload at $pluginTarget"
}

Ensure-Directory $pluginTarget
Copy-PluginPayload -SourceRoot $repoRoot -TargetRoot $pluginTarget

Push-Location $pluginTarget
try {
  & npm.cmd install --omit=dev --ignore-scripts --package-lock=false
  if ($LASTEXITCODE -ne 0) {
    throw "npm install --omit=dev failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

$generatedLock = Join-Path $pluginTarget "package-lock.json"
if (Test-Path $generatedLock) {
  cmd /c del /f /q "$generatedLock" | Out-Null
}

$pluginVersion = Read-PackageVersion (Join-Path $pluginTarget "package.json")
$pluginCacheVersionTarget = Join-Path $pluginCacheTarget $pluginVersion

Ensure-Directory $pluginCacheVersionTarget
Copy-CachePayload -SourceRoot $pluginTarget -TargetRoot $pluginCacheVersionTarget

if (Test-Path $pluginCacheTarget) {
  Get-ChildItem $pluginCacheTarget -Directory | Where-Object { $_.Name -ne $pluginVersion } | ForEach-Object {
    Write-Host "Removing stale cached plugin version at $($_.FullName)"
    cmd /c rmdir /s /q "$($_.FullName)" | Out-Null
  }
}

if (Test-Path $tmpPluginTarget) {
  Write-Host "Clearing temporary expanded plugin bundle at $tmpPluginTarget"
  cmd /c rmdir /s /q "$tmpPluginTarget" | Out-Null
}

$marketplace =
  if (Test-Path $marketplacePath) {
    try {
      Get-Content -Raw $marketplacePath | ConvertFrom-Json
    } catch {
      New-MarketplaceObject
    }
  } else {
    New-MarketplaceObject
  }

if (-not $marketplace.name) {
  $marketplace | Add-Member -NotePropertyName name -NotePropertyValue "local-personal-plugins"
}

if (-not $marketplace.interface) {
  $marketplace | Add-Member -NotePropertyName interface -NotePropertyValue ([pscustomobject]@{
    displayName = "Local Personal Plugins"
  })
}

$plugins = @($marketplace.plugins)
$entry = [pscustomobject]@{
  name = $PluginName
  source = [pscustomobject]@{
    source = "local"
    path = $marketplaceSourcePath
  }
  policy = [pscustomobject]@{
    installation = "INSTALLED_BY_DEFAULT"
    authentication = "ON_INSTALL"
  }
  category = "Developer Tools"
}

$existingIndex = -1
for ($i = 0; $i -lt $plugins.Count; $i += 1) {
  if ($plugins[$i].name -eq $PluginName) {
    $existingIndex = $i
    break
  }
}

if ($existingIndex -ge 0) {
  $plugins[$existingIndex] = $entry
} else {
  $plugins += $entry
}

$marketplace.plugins = $plugins
$marketplaceJson = $marketplace | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$marketplaceBytes = $utf8NoBom.GetBytes($marketplaceJson)
[System.IO.File]::WriteAllBytes($marketplacePath, $marketplaceBytes)

Write-Host "Installed $PluginName to Codex local marketplace."
Write-Host "Plugin payload: $pluginTarget"
Write-Host "Marketplace file: $marketplacePath"
