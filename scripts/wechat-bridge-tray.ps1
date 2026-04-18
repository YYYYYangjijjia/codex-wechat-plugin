param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
[System.Windows.Forms.Application]::EnableVisualStyles()
$trayMutexName = "Global\CodexWeChatBridgeTray"
$createdNew = $false
$trayMutex = New-Object System.Threading.Mutex($true, $trayMutexName, [ref]$createdNew)
if (-not $createdNew) {
  exit 0
}
$trayIconPath = Join-Path $RepoRoot "assets\tray\codex_wechat_tray_round.ico"
$daemonLockPath = Join-Path $RepoRoot "state\daemon.lock"

function Get-NodeEntryScript {
  param([string]$Name)
  $dist = Join-Path $RepoRoot "dist\src\cli\$Name.js"
  if (Test-Path $dist) {
    return @{ Command = "node"; Arguments = @($dist) }
  }
  $src = Join-Path $RepoRoot "src\cli\$Name.ts"
  return @{ Command = "npx"; Arguments = @("tsx", $src) }
}

function Read-LockRecord {
  param([string]$LockPath)
  if (-not (Test-Path -LiteralPath $LockPath)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-ProcessAliveById {
  param([int]$ProcessId)
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Test-DaemonRunning {
  $lock = Read-LockRecord -LockPath $daemonLockPath
  if ($lock -and $lock.pid) {
    return (Test-ProcessAliveById -ProcessId ([int]$lock.pid))
  }
  return $false
}

function Remove-StaleDaemonLock {
  $lock = Read-LockRecord -LockPath $daemonLockPath
  if (-not $lock -or -not $lock.pid) {
    return $false
  }
  if (Test-ProcessAliveById -ProcessId ([int]$lock.pid)) {
    return $false
  }
  Remove-Item -LiteralPath $daemonLockPath -Force -ErrorAction SilentlyContinue
  return $true
}

function Stop-DaemonProcess {
  $lock = Read-LockRecord -LockPath $daemonLockPath
  if ($lock -and $lock.pid) {
    Stop-Process -Id ([int]$lock.pid) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (-not (Test-ProcessAliveById -ProcessId ([int]$lock.pid))) {
      Remove-Item -LiteralPath $daemonLockPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-DaemonProcess {
  if (Test-DaemonRunning) {
    return $false
  }
  [void](Remove-StaleDaemonLock)
  $entry = Get-NodeEntryScript -Name "daemon"
  Start-Process -FilePath $entry.Command -ArgumentList $entry.Arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
  return $true
}

function Ensure-DaemonProcess {
  if (Test-DaemonRunning) {
    return $false
  }
  return (Start-DaemonProcess)
}

function Get-BridgeProcess {
  param([string[]]$Patterns)
  $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine })
  foreach ($pattern in $Patterns) {
    $processes = @($processes | Where-Object {
      $_.CommandLine -and $_.CommandLine -like "*$pattern*"
    })
    if ($processes.Count -eq 0) {
      return @()
    }
  }
  return $processes
}

function Start-BridgeProcess {
  param(
    [string]$Name,
    [string[]]$Patterns
  )
  if ($Name -eq "daemon") {
    return (Start-DaemonProcess)
  }
  if ($Name -eq "mcp-server") {
    return $false
  }
  if (@(Get-BridgeProcess -Patterns $Patterns).Count -gt 0) {
    return $false
  }
  $entry = Get-NodeEntryScript -Name $Name
  Start-Process -FilePath $entry.Command -ArgumentList $entry.Arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
  return $true
}

function Ensure-BridgeProcess {
  param(
    [string]$Name,
    [string[]]$Patterns
  )
  if ($Name -eq "daemon") {
    return (Ensure-DaemonProcess)
  }
  if ($Name -eq "mcp-server") {
    return $false
  }
  if (@(Get-BridgeProcess -Patterns $Patterns).Count -gt 0) {
    return $false
  }
  return (Start-BridgeProcess -Name $Name -Patterns $Patterns)
}

function Stop-BridgeProcess {
  param([string[]]$Patterns)
  $processes = @(Get-BridgeProcess -Patterns $Patterns)
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Restart-BridgeProcess {
  param(
    [string]$Name,
    [string[]]$Patterns
  )
  Stop-BridgeProcess -Patterns $Patterns
  Start-Sleep -Milliseconds 400
  [void](Start-BridgeProcess -Name $Name -Patterns $Patterns)
}

function Invoke-LoginFlow {
  $entry = Get-NodeEntryScript -Name "login"
  Start-Process -FilePath $entry.Command -ArgumentList $entry.Arguments -WorkingDirectory $RepoRoot
}

function Invoke-StatusSnapshot {
  $entry = Get-NodeEntryScript -Name "status"
  $arguments = @($entry.Arguments + "--json")
  $previousNoWarnings = $env:NODE_NO_WARNINGS
  try {
    $env:NODE_NO_WARNINGS = "1"
    $output = & $entry.Command @arguments 2>$null
    if (-not $output) {
      return $null
    }
    return ($output | Out-String | ConvertFrom-Json)
  } catch {
    return $null
  } finally {
    if ($null -eq $previousNoWarnings) {
      Remove-Item Env:NODE_NO_WARNINGS -ErrorAction SilentlyContinue
    } else {
      $env:NODE_NO_WARNINGS = $previousNoWarnings
    }
  }
}

function Sync-RefreshStateFromSnapshot {
  param($Snapshot)
  $refreshState.Snapshot = $Snapshot
  $refreshState.DaemonRunning = [bool]($Snapshot -and $Snapshot.daemon -and $Snapshot.daemon.running)
  $refreshState.McpRunning = Test-McpRunning
  $refreshState.ErrorMessage = $null
  $refreshState.RefreshedAt = Get-Date
}

function Wait-ForDaemonHealthy {
  param(
    [int]$PreviousPid = 0,
    [int]$TimeoutMs = 15000,
    [int]$PollIntervalMs = 700
  )
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  do {
    Start-Sleep -Milliseconds $PollIntervalMs
    $snapshot = Invoke-StatusSnapshot
    if (
      $snapshot -and
      $snapshot.daemon -and
      $snapshot.daemon.running -and
      $snapshot.daemon.healthy -and
      ([int]$snapshot.daemon.pid -ne $PreviousPid)
    ) {
      Sync-RefreshStateFromSnapshot -Snapshot $snapshot
      return $snapshot
    }
  } while ((Get-Date) -lt $deadline)

  $snapshot = Invoke-StatusSnapshot
  if ($snapshot) {
    Sync-RefreshStateFromSnapshot -Snapshot $snapshot
  }
  return $snapshot
}

function Start-StatusRefreshJob {
  param([string]$RepoRoot)
  Start-Job -ScriptBlock {
    param($RepoRoot)
    Set-Location -LiteralPath $RepoRoot

    $snapshot = $null
    $errorMessage = $null
    $entryDist = Join-Path $RepoRoot "dist\src\cli\status.js"
    $entrySrc = Join-Path $RepoRoot "src\cli\status.ts"
    if (Test-Path $entryDist) {
      $command = "node"
      $arguments = @($entryDist, "--json")
    } else {
      $command = "npx"
      $arguments = @("tsx", $entrySrc, "--json")
    }

    $previousNoWarnings = $env:NODE_NO_WARNINGS
    try {
      $env:NODE_NO_WARNINGS = "1"
      $output = & $command @arguments 2>$null
      if ($output) {
        $snapshot = ($output | Out-String | ConvertFrom-Json)
      }
    } catch {
      $errorMessage = $_.Exception.Message
    } finally {
      if ($null -eq $previousNoWarnings) {
        Remove-Item Env:NODE_NO_WARNINGS -ErrorAction SilentlyContinue
      } else {
        $env:NODE_NO_WARNINGS = $previousNoWarnings
      }
    }

    [pscustomobject]@{
      Snapshot      = $snapshot
      DaemonRunning = [bool]($snapshot -and $snapshot.daemon -and $snapshot.daemon.running)
      McpRunning    = $false
      ErrorMessage  = $errorMessage
      RefreshedAt   = (Get-Date).ToString("o")
    }
  } -ArgumentList $RepoRoot
}

function Format-StatusMessage {
  param(
    $Snapshot,
    [bool]$DaemonRunning,
    [bool]$McpRunning
  )
  $mcpState = if ($McpRunning) { "on-demand / active" } else { "on-demand / idle" }
  if (-not $Snapshot) {
    return "No bridge status available."
  }
  $lines = @(
    "WeChat Bridge",
    "workspace: $($Snapshot.workspaceDir)",
    "accounts: $($Snapshot.accounts.total) total / $($Snapshot.accounts.active) active",
    "daemon: $(if ($Snapshot.daemon.running) { 'running' } else { 'stopped' }) / heartbeat $(if ($Snapshot.daemon.healthy) { 'healthy' } else { 'stale' })",
    "mcp: $mcpState",
    "codex app-server: $(if ($Snapshot.codex.appServerConnected) { 'connected' } else { 'disconnected' })",
    "pending: $($Snapshot.pendingMessages.pending) pending / $($Snapshot.pendingMessages.failed) failed",
    "last reply: $(if ($Snapshot.latestReplyTiming) { "$($Snapshot.latestReplyTiming.runnerBackend) / $($Snapshot.latestReplyTiming.totalMs) ms" } else { 'none' })"
  )
  return ($lines -join [Environment]::NewLine)
}

$daemonPatterns = @("codex-wechat-plugin", "daemon.js")
$daemonTsPatterns = @("codex-wechat-plugin", "daemon.ts")
$mcpPatterns = @("codex-wechat-plugin", "mcp-server.js")
$mcpTsPatterns = @("codex-wechat-plugin", "mcp-server.ts")

function Test-McpRunning {
  return @(Get-BridgeProcess -Patterns $mcpPatterns).Count -gt 0 -or @(Get-BridgeProcess -Patterns $mcpTsPatterns).Count -gt 0
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = if (Test-Path $trayIconPath) { [System.Drawing.Icon]::ExtractAssociatedIcon($trayIconPath) } else { [System.Drawing.SystemIcons]::Information }
$notifyIcon.Text = "WeChat Bridge"
$notifyIcon.Visible = $true

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$refreshState = [hashtable]::Synchronized(@{
  Snapshot       = $null
  DaemonRunning  = $false
  McpRunning     = $false
  ErrorMessage   = $null
  RefreshedAt    = [datetime]::MinValue
})
$refreshJob = $null
$lastRefreshStartedAt = [datetime]::MinValue
$daemonAutoRestartEnabled = $true

$showStatus = $contextMenu.Items.Add("Show Status")
$showStatus.Add_Click({
  try {
    $snapshot = Invoke-StatusSnapshot
    Sync-RefreshStateFromSnapshot -Snapshot $snapshot
    $daemonRunning = [bool]($refreshState.DaemonRunning)
    $mcpRunning = [bool]($refreshState.McpRunning)
    $suffix = if ($refreshState.RefreshedAt -is [datetime] -and $refreshState.RefreshedAt -ne [datetime]::MinValue) {
      [Environment]::NewLine + [Environment]::NewLine + "refreshed: $($refreshState.RefreshedAt.ToString("s"))"
    } else {
      ""
    }
    [System.Windows.Forms.MessageBox]::Show((Format-StatusMessage -Snapshot $snapshot -DaemonRunning $daemonRunning -McpRunning $mcpRunning) + $suffix, "WeChat Bridge Status") | Out-Null
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Failed to read bridge status.`n$($_.Exception.Message)", "WeChat Bridge Status") | Out-Null
  }
})

$null = $contextMenu.Items.Add("-")

$startDaemon = $contextMenu.Items.Add("Start Daemon")
$startDaemon.Add_Click({
  $script:daemonAutoRestartEnabled = $true
  if (-not (Test-DaemonRunning)) {
    [void](Start-DaemonProcess)
  }
})
$stopDaemon = $contextMenu.Items.Add("Stop Daemon")
$stopDaemon.Add_Click({
  $script:daemonAutoRestartEnabled = $false
  Stop-DaemonProcess
})
$restartDaemon = $contextMenu.Items.Add("Restart Daemon")
$restartDaemon.Add_Click({
  $script:daemonAutoRestartEnabled = $true
  $previousPid = 0
  try {
    $snapshot = Invoke-StatusSnapshot
    if ($snapshot -and $snapshot.daemon -and $snapshot.daemon.pid) {
      $previousPid = [int]$snapshot.daemon.pid
    }
  } catch {}
  Stop-DaemonProcess
  Start-Sleep -Milliseconds 400
  [void](Start-DaemonProcess)
  $snapshot = Wait-ForDaemonHealthy -PreviousPid $previousPid
  if ($snapshot -and $snapshot.daemon.running -and $snapshot.daemon.healthy -and ([int]$snapshot.daemon.pid -ne $previousPid)) {
    $notifyIcon.ShowBalloonTip(3000, "WeChat Bridge", "Daemon restarted successfully.", [System.Windows.Forms.ToolTipIcon]::Info)
  } else {
    $notifyIcon.ShowBalloonTip(3000, "WeChat Bridge", "Daemon restart is still pending health confirmation.", [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})

$startMcp = $contextMenu.Items.Add("MCP Help")
$startMcp.Add_Click({
  $notifyIcon.ShowBalloonTip(
    4000,
    "WeChat Bridge",
    "The MCP server uses stdio and is started by Codex Desktop on demand. Use the plugin again after restarting Codex Desktop if you need a fresh MCP connection.",
    [System.Windows.Forms.ToolTipIcon]::Info
  )
})
$stopMcp = $contextMenu.Items.Add("Stop Current MCP Processes")
$stopMcp.Add_Click({ Stop-BridgeProcess -Patterns $mcpPatterns; Stop-BridgeProcess -Patterns $mcpTsPatterns })
$restartMcp = $contextMenu.Items.Add("Reset MCP Connection")
$restartMcp.Add_Click({
  Stop-BridgeProcess -Patterns $mcpPatterns
  Stop-BridgeProcess -Patterns $mcpTsPatterns
  Start-Sleep -Milliseconds 400
  $notifyIcon.ShowBalloonTip(
    4000,
    "WeChat Bridge",
    "Stopped current MCP server processes. Codex Desktop will relaunch the stdio MCP server the next time the plugin is used.",
    [System.Windows.Forms.ToolTipIcon]::Info
  )
})

$relogin = $contextMenu.Items.Add("Re-Login WeChat")
$relogin.Add_Click({ Invoke-LoginFlow })

$openState = $contextMenu.Items.Add("Open State Folder")
$openState.Add_Click({ Start-Process explorer.exe (Join-Path $RepoRoot "state") })
$openRepo = $contextMenu.Items.Add("Open Plugin Runtime")
$openRepo.Add_Click({ Start-Process explorer.exe $RepoRoot })

$null = $contextMenu.Items.Add("-")

$exitItem = $contextMenu.Items.Add("Exit Tray")
$exitItem.Add_Click({
  $timer.Stop()
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $trayMutex.ReleaseMutex()
  $trayMutex.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $contextMenu
$lastDaemonAutoRestartAt = [datetime]::MinValue

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.Add_Tick({
  try {
    if ($contextMenu.Visible) {
      return
    }
    if ($refreshJob -and $refreshJob.State -in @("Completed", "Failed", "Stopped")) {
      try {
        $jobResult = Receive-Job -Job $refreshJob -ErrorAction Stop
        if ($jobResult) {
          $refreshState.Snapshot = $jobResult.Snapshot
          $refreshState.DaemonRunning = [bool]$jobResult.DaemonRunning
          $refreshState.McpRunning = [bool]$jobResult.McpRunning
          $refreshState.ErrorMessage = $jobResult.ErrorMessage
          $refreshState.RefreshedAt = [datetime]::Parse($jobResult.RefreshedAt)
        }
      } catch {
        $refreshState.ErrorMessage = $_.Exception.Message
      } finally {
        Remove-Job -Job $refreshJob -Force -ErrorAction SilentlyContinue
        $refreshJob = $null
      }
    }

    $now = Get-Date
    if (-not $refreshJob -and (($now - $lastRefreshStartedAt).TotalSeconds -ge 5)) {
      $refreshJob = Start-StatusRefreshJob -RepoRoot $RepoRoot
      $lastRefreshStartedAt = $now
    }

    $snapshot = $refreshState.Snapshot
    $daemonRunning = [bool]$refreshState.DaemonRunning
    $mcpRunning = [bool]$refreshState.McpRunning
    if (-not $daemonRunning) {
      if ($daemonAutoRestartEnabled -and ($now - $lastDaemonAutoRestartAt).TotalSeconds -ge 15) {
        if (Ensure-DaemonProcess) {
          $lastDaemonAutoRestartAt = $now
          $daemonRunning = Test-DaemonRunning
          $refreshState.DaemonRunning = $daemonRunning
          $notifyIcon.ShowBalloonTip(3000, "WeChat Bridge", "Daemon stopped unexpectedly and was restarted.", [System.Windows.Forms.ToolTipIcon]::Warning)
        }
      }
    }
    if ($snapshot -and $daemonRunning -and $snapshot.codex.appServerConnected -and $snapshot.accounts.active -gt 0) {
      $notifyIcon.Icon = if (Test-Path $trayIconPath) { [System.Drawing.Icon]::ExtractAssociatedIcon($trayIconPath) } else { [System.Drawing.SystemIcons]::Information }
    } elseif ($daemonRunning -or $mcpRunning) {
      $notifyIcon.Icon = if (Test-Path $trayIconPath) { [System.Drawing.Icon]::ExtractAssociatedIcon($trayIconPath) } else { [System.Drawing.SystemIcons]::Warning }
    } else {
      $notifyIcon.Icon = if (Test-Path $trayIconPath) { [System.Drawing.Icon]::ExtractAssociatedIcon($trayIconPath) } else { [System.Drawing.SystemIcons]::Error }
    }
    $notifyIcon.Text = "WeChat Bridge | daemon $(if ($daemonRunning) { 'on' } else { 'off' }) | wechat $(if ($snapshot -and $snapshot.accounts.active -gt 0) { 'on' } else { 'off' }) | codex $(if ($snapshot -and $snapshot.codex.appServerConnected) { 'on' } else { 'off' })"
  } catch {
    $notifyIcon.Icon = if (Test-Path $trayIconPath) { [System.Drawing.Icon]::ExtractAssociatedIcon($trayIconPath) } else { [System.Drawing.SystemIcons]::Warning }
    $notifyIcon.Text = "WeChat Bridge | status unavailable"
  }
})
$timer.Start()

$contextMenu.Add_Opening({
  $timer.Stop()
})

$contextMenu.Add_Closed({
  $timer.Start()
})

$startupActions = @()
if (-not (Test-DaemonRunning) -and (Ensure-DaemonProcess)) {
  $startupActions += "daemon"
}
if ($startupActions.Count -gt 0) {
  $notifyIcon.ShowBalloonTip(3000, "WeChat Bridge", "Started " + ($startupActions -join " and ") + ".", [System.Windows.Forms.ToolTipIcon]::Info)
}

$notifyIcon.Add_DoubleClick({
  $showStatus.PerformClick()
})

[System.Windows.Forms.Application]::Run()
