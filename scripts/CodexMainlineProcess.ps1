$ErrorActionPreference = "Stop"

function Get-CodexMainlinePaths {
    $scriptDir = Split-Path -Parent $PSCommandPath
    $workspaceRoot = Resolve-Path (Join-Path $scriptDir "..")
    $runtimeDir = Join-Path $workspaceRoot "runtime\tg_mainline"
    $statePath = Join-Path $runtimeDir "state.json"
    $settingsPath = Join-Path $workspaceRoot "config\codex-mainline.settings.json"

    [pscustomobject]@{
        WorkspaceRoot = $workspaceRoot.Path
        RuntimeDir = $runtimeDir
        LockPath = Join-Path $runtimeDir "mainline.lock.json"
        StatePath = $statePath
        SettingsPath = $settingsPath
        StartScript = Join-Path $scriptDir "Start-CodexMainline.ps1"
        WatchdogStartScript = Join-Path $scriptDir "Start-CodexMainlineWatchdog.ps1"
        WatchdogScript = Join-Path $scriptDir "Watch-CodexMainline.ps1"
        NodeScript = Join-Path $workspaceRoot "src\start-codex-mainline.mjs"
        DisableMarker = Join-Path $runtimeDir "keepalive.disabled"
        ShutdownMarker = Join-Path $runtimeDir "shutdown_in_progress"
        WatchdogLockPath = Join-Path $runtimeDir "watchdog.lock.json"
        WatchdogInstanceLockPath = Join-Path $runtimeDir "watchdog.instance.lock"
        ShutdownLog = Join-Path $runtimeDir "shutdown.jsonl"
        KeepaliveLog = Join-Path $runtimeDir "keepalive.jsonl"
        LaunchStdout = Join-Path $runtimeDir "mainline.launch.stdout.log"
        LaunchStderr = Join-Path $runtimeDir "mainline.launch.stderr.log"
        LaunchLatest = Join-Path $runtimeDir "mainline.launch.latest.json"
        ReadyPath = Join-Path $runtimeDir "mainline.ready.json"
        RestartRequestPath = Join-Path $runtimeDir "mainline.restart.request.json"
    }
}

function Write-CodexMainlineJsonl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Data
    )

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $entry = [ordered]@{
        ts = (Get-Date).ToUniversalTime().ToString("o")
    }
    foreach ($property in $Data.PSObject.Properties) {
        $entry[$property.Name] = $property.Value
    }
    ($entry | ConvertTo-Json -Compress -Depth 8) | Add-Content -LiteralPath $Path -Encoding UTF8
}

function Read-CodexMainlineJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }
    $raw | ConvertFrom-Json
}

function Write-CodexMainlineJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Data
    )

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = "$Path.tmp-$PID-$(Get-Date -Format 'yyyyMMddHHmmssfff')"
    $Data | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Quote-CodexMainlineCmdArg {
    param([Parameter(Mandatory = $true)][string]$Value)

    '"' + ($Value -replace '"', '\"') + '"'
}

function Start-CodexMainlineVisibleCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$Arguments = @()
    )

    $parts = @(
        "/c",
        "start",
        (Quote-CodexMainlineCmdArg -Value $Title),
        "/D",
        (Quote-CodexMainlineCmdArg -Value $WorkingDirectory),
        (Quote-CodexMainlineCmdArg -Value $Command)
    )
    foreach ($arg in $Arguments) {
        $parts += Quote-CodexMainlineCmdArg -Value $arg
    }

    Start-Process -FilePath "cmd.exe" -ArgumentList ($parts -join " ") -PassThru
}

function Test-CodexMainlineProcessAlive {
    param([int]$PidValue)

    if ($PidValue -le 0) {
        return $false
    }
    return $null -ne (Get-Process -Id $PidValue -ErrorAction SilentlyContinue)
}

function Test-CodexMainlineProcessCommandLineContains {
    param(
        [int]$PidValue,
        [Parameter(Mandatory = $true)][string]$ExpectedPath
    )

    if (-not (Test-CodexMainlineProcessAlive -PidValue $PidValue)) {
        return $false
    }

    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction Stop
        if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)) {
            return $false
        }
        return $process.CommandLine.IndexOf($ExpectedPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } catch {
        return $false
    }
}

function Get-CodexMainlineProcessLock {
    param([Parameter(Mandatory = $true)]$Paths)

    $lock = Read-CodexMainlineJson -Path $Paths.LockPath
    if ($null -eq $lock -or $null -eq $lock.pid) {
        return [pscustomobject]@{
            Pid = $null
            Alive = $false
            StartedAt = $null
            Exists = $false
        }
    }

    $pidValue = [int]$lock.pid
    [pscustomobject]@{
        Pid = $pidValue
        Alive = Test-CodexMainlineProcessCommandLineContains -PidValue $pidValue -ExpectedPath $Paths.NodeScript
        StartedAt = $lock.started_at
        Exists = $true
    }
}

function Get-CodexMainlineReady {
    param([Parameter(Mandatory = $true)]$Paths)

    $ready = Read-CodexMainlineJson -Path $Paths.ReadyPath
    if ($null -eq $ready -or $null -eq $ready.pid) {
        return [pscustomobject]@{
            Ready = $false
            Pid = $null
            Endpoint = $null
            ReadyAt = $null
            Exists = $false
        }
    }

    $pidValue = [int]$ready.pid
    [pscustomobject]@{
        Ready = (Test-CodexMainlineProcessCommandLineContains -PidValue $pidValue -ExpectedPath $Paths.NodeScript)
        Pid = $pidValue
        Endpoint = $ready.endpoint
        ReadyAt = $ready.ready_at
        Exists = $true
    }
}

function Clear-CodexMainlineActiveState {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [string]$Reason = "mainline supervisor cleanup"
    )

    $state = Read-CodexMainlineJson -Path $Paths.StatePath
    if ($null -eq $state) {
        return $false
    }

    $changed = $false
    foreach ($name in @("active_turn_id", "active_turn_started_at", "work_budget_turn_id", "work_budget_steered_at")) {
        if ($null -ne $state.$name) {
            $state.$name = $null
            $changed = $true
        }
    }

    if ($changed) {
        $state.last_wake_skip_at = (Get-Date).ToUniversalTime().ToString("o")
        $state.last_wake_skip_reason = $Reason
        $state.updated_at = (Get-Date).ToUniversalTime().ToString("o")
        Write-CodexMainlineJson -Path $Paths.StatePath -Data $state
    }

    return $changed
}

function Disable-CodexMainlineRhythm {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [string]$Reason = "watchdog_start_default_off",
        [switch]$DryRun
    )

    if ($DryRun) {
        return [pscustomobject]@{
            Changed = $false
            SettingsChanged = $false
            StateChanged = $false
            Reason = "dry_run"
        }
    }

    $settingsChanged = $false
    $settings = Read-CodexMainlineJson -Path $Paths.SettingsPath
    if ($null -ne $settings -and $settings.rhythm_enabled -ne $false) {
        $settings.rhythm_enabled = $false
        $settingsChanged = $true
        Write-CodexMainlineJson -Path $Paths.SettingsPath -Data $settings
    }

    $stateChanged = $false
    $state = Read-CodexMainlineJson -Path $Paths.StatePath
    if ($null -ne $state -and $null -ne $state.next_wake_at) {
        $state.next_wake_at = $null
        $state.last_wake_skip_at = (Get-Date).ToUniversalTime().ToString("o")
        $state.last_wake_skip_reason = $Reason
        $state.updated_at = (Get-Date).ToUniversalTime().ToString("o")
        $stateChanged = $true
        Write-CodexMainlineJson -Path $Paths.StatePath -Data $state
    }

    [pscustomobject]@{
        Changed = ($settingsChanged -or $stateChanged)
        SettingsChanged = $settingsChanged
        StateChanged = $stateChanged
        Reason = $Reason
    }
}

function Remove-CodexMainlineStaleLock {
    param([Parameter(Mandatory = $true)]$Paths)

    $lock = Get-CodexMainlineProcessLock -Paths $Paths
    if ($lock.Exists -and -not $lock.Alive) {
        Remove-Item -LiteralPath $Paths.LockPath -Force
        return $true
    }
    return $false
}

function Update-CodexMainlineWatchdogLock {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [int]$CheckIntervalSeconds = 10,
        [switch]$HiddenMainline
    )

    Write-CodexMainlineJson -Path $Paths.WatchdogLockPath -Data ([ordered]@{
        pid = $PID
        workspace_root = $Paths.WorkspaceRoot
        updated_at = (Get-Date).ToUniversalTime().ToString("o")
        check_interval_seconds = $CheckIntervalSeconds
        hidden_mainline = [bool]$HiddenMainline
    })
}

function Get-CodexMainlineWatchdogLock {
    param([Parameter(Mandatory = $true)]$Paths)

    $lock = Read-CodexMainlineJson -Path $Paths.WatchdogLockPath
    if ($null -eq $lock -or $null -eq $lock.pid) {
        return [pscustomobject]@{
            Pid = $null
            Alive = $false
            UpdatedAt = $null
            Exists = $false
        }
    }

    $pidValue = [int]$lock.pid
    [pscustomobject]@{
        Pid = $pidValue
        Alive = Test-CodexMainlineProcessCommandLineContains -PidValue $pidValue -ExpectedPath $Paths.WatchdogScript
        UpdatedAt = $lock.updated_at
        Exists = $true
    }
}

function Test-CodexMainlineWatchdogAvailable {
    param([Parameter(Mandatory = $true)]$Paths)

    $lock = Get-CodexMainlineWatchdogLock -Paths $Paths
    if ($lock.Exists -and -not $lock.Alive) {
        Remove-Item -LiteralPath $Paths.WatchdogLockPath -Force -ErrorAction SilentlyContinue
        return $false
    }

    return $lock.Alive
}

function Start-CodexMainlineWatchdogProcess {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$HiddenMainline,
        [switch]$DryRun
    )

    if ($DryRun) {
        return $null
    }
    if (Test-CodexMainlineWatchdogAvailable -Paths $Paths) {
        return $null
    }

    $shell = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $shell) {
        $shell = Get-Command powershell.exe -ErrorAction SilentlyContinue
    }
    $shellPath = if ($shell) { $shell.Source } else { "powershell.exe" }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $Paths.WatchdogStartScript,
        "-HiddenWatchdog"
    )
    if ($HiddenMainline) {
        $arguments += "-HiddenMainline"
    }

    return Start-Process `
        -FilePath $shellPath `
        -ArgumentList $arguments `
        -WorkingDirectory $Paths.WorkspaceRoot `
        -WindowStyle Hidden `
        -PassThru
}

function Wait-CodexMainlineWatchdogStarted {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [int]$TimeoutSeconds = 10
    )

    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $lock = Get-CodexMainlineWatchdogLock -Paths $Paths
        if ($lock.Alive) {
            return [pscustomobject]@{
                Started = $true
                Pid = $lock.Pid
                Reason = "lock_alive"
            }
        }
    }

    $finalLock = Get-CodexMainlineWatchdogLock -Paths $Paths
    [pscustomobject]@{
        Started = $false
        Pid = $finalLock.Pid
        Reason = if ($finalLock.Exists) { "lock_not_alive" } else { "no_lock" }
    }
}

function Ensure-CodexMainlineWatchdog {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$HiddenMainline,
        [switch]$DryRun
    )

    $existing = Get-CodexMainlineWatchdogLock -Paths $Paths
    if ($existing.Alive) {
        return [pscustomobject]@{
            Alive = $true
            Started = $false
            Pid = $existing.Pid
            Reason = "already_alive"
            LauncherPid = $null
        }
    }

    $launcher = Start-CodexMainlineWatchdogProcess -Paths $Paths -HiddenMainline:$HiddenMainline -DryRun:$DryRun
    if ($DryRun) {
        return [pscustomobject]@{
            Alive = $false
            Started = $false
            Pid = $null
            Reason = "dry_run"
            LauncherPid = $null
        }
    }

    $started = Wait-CodexMainlineWatchdogStarted -Paths $Paths -TimeoutSeconds 10
    [pscustomobject]@{
        Alive = $started.Started
        Started = $started.Started
        Pid = $started.Pid
        Reason = $started.Reason
        LauncherPid = if ($launcher) { $launcher.Id } else { $null }
    }
}

function Acquire-CodexMainlineWatchdogInstanceLock {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$DryRun
    )

    if ($DryRun) {
        return [pscustomobject]@{
            Acquired = $true
            Path = $Paths.WatchdogInstanceLockPath
            Stream = $null
            DryRun = $true
        }
    }

    if (-not (Test-Path -LiteralPath $Paths.RuntimeDir)) {
        New-Item -ItemType Directory -Path $Paths.RuntimeDir -Force | Out-Null
    }

    try {
        $stream = [System.IO.File]::Open(
            $Paths.WatchdogInstanceLockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $stream.SetLength(0)
        $metadata = ([ordered]@{
            pid = $PID
            acquired_at = (Get-Date).ToUniversalTime().ToString("o")
        } | ConvertTo-Json -Compress)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($metadata)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        return [pscustomobject]@{
            Acquired = $true
            Path = $Paths.WatchdogInstanceLockPath
            Stream = $stream
            DryRun = $false
        }
    } catch [System.IO.IOException] {
        $lock = Get-CodexMainlineWatchdogLock -Paths $Paths
        return [pscustomobject]@{
            Acquired = $false
            Path = $Paths.WatchdogInstanceLockPath
            ExistingPid = $lock.Pid
            ExistingAlive = $lock.Alive
            Reason = "instance_lock_held"
            DryRun = $false
        }
    }
}

function Release-CodexMainlineWatchdogInstanceLock {
    param($InstanceLock)

    if ($null -eq $InstanceLock -or -not $InstanceLock.Acquired -or $InstanceLock.DryRun) {
        return
    }

    try {
        if ($null -ne $InstanceLock.Stream) {
            $InstanceLock.Stream.Dispose()
        }
    } finally {
        Remove-Item -LiteralPath $InstanceLock.Path -Force -ErrorAction SilentlyContinue
    }
}

function Start-CodexMainlineNodeProcess {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$Hidden,
        [string]$WakeMessage,
        [switch]$DryRun
    )

    if ($DryRun) {
        return $null
    }

    Remove-Item -LiteralPath $Paths.ReadyPath -Force -ErrorAction SilentlyContinue

    if (-not $Hidden) {
        $shell = (Get-Command pwsh -ErrorAction SilentlyContinue)
        if (-not $shell) {
            $shell = Get-Command powershell.exe -ErrorAction SilentlyContinue
        }
        $shellPath = if ($shell) { $shell.Source } else { "powershell.exe" }
        $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Paths.StartScript)
        if (-not [string]::IsNullOrWhiteSpace($WakeMessage)) {
            $arguments += @("-StartupMessage", $WakeMessage)
        }
        return Start-CodexMainlineVisibleCommand `
            -Title "Codex Mainline" `
            -WorkingDirectory $Paths.WorkspaceRoot `
            -Command $shellPath `
            -Arguments $arguments
    }

    $node = Get-Command node -ErrorAction Stop
    $arguments = @($Paths.NodeScript)
    if (-not [string]::IsNullOrWhiteSpace($WakeMessage)) {
        $arguments += @("--startup-message", $WakeMessage)
    }
    $argumentLine = ($arguments | ForEach-Object { Quote-CodexMainlineCmdArg -Value $_ }) -join " "
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss-fff")
    $launchStdout = Join-Path $Paths.RuntimeDir "mainline.launch.$stamp.stdout.log"
    $launchStderr = Join-Path $Paths.RuntimeDir "mainline.launch.$stamp.stderr.log"
    $process = Start-Process `
        -FilePath $node.Source `
        -ArgumentList $argumentLine `
        -WorkingDirectory $Paths.WorkspaceRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $launchStdout `
        -RedirectStandardError $launchStderr `
        -PassThru

    $launchInfo = [pscustomobject]@{
        pid = $process.Id
        started_at = (Get-Date).ToUniversalTime().ToString("o")
        stdout = $launchStdout
        stderr = $launchStderr
        hidden = $true
    }
    Write-CodexMainlineJson -Path $Paths.LaunchLatest -Data $launchInfo
    Write-CodexMainlineJsonl -Path $Paths.KeepaliveLog -Data ([pscustomobject]@{
        event = "mainline_process_launched"
        pid = $process.Id
        stdout = $launchStdout
        stderr = $launchStderr
        hidden = $true
    })
    return $process
}

function Wait-CodexMainlineStarted {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $lock = Get-CodexMainlineProcessLock -Paths $Paths
        if ($lock.Alive) {
            $ready = Get-CodexMainlineReady -Paths $Paths
            if ($ready.Ready -and $ready.Pid -eq $lock.Pid) {
                return [pscustomobject]@{
                    Started = $true
                    Pid = $lock.Pid
                    Reason = "ready"
                }
            }
        }
    }

    $finalLock = Get-CodexMainlineProcessLock -Paths $Paths
    $finalReady = Get-CodexMainlineReady -Paths $Paths
    [pscustomobject]@{
        Started = $false
        Pid = $finalLock.Pid
        Reason = if ($finalLock.Alive -and -not ($finalReady.Ready -and $finalReady.Pid -eq $finalLock.Pid)) { "lock_alive_not_ready" } elseif ($finalLock.Exists) { "lock_not_alive" } else { "no_lock" }
    }
}

function Stop-CodexMainlineNodeProcess {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [int]$WaitSeconds = 5,
        [switch]$DryRun
    )

    $lock = Get-CodexMainlineProcessLock -Paths $Paths
    if (-not $lock.Exists) {
        return [pscustomobject]@{ Stopped = $false; Reason = "no_lock"; Pid = $null }
    }
    if (-not $lock.Alive) {
        Remove-CodexMainlineStaleLock -Paths $Paths | Out-Null
        Remove-Item -LiteralPath $Paths.ReadyPath -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Stopped = $false; Reason = "stale_lock_removed"; Pid = $lock.Pid }
    }

    if ($DryRun) {
        return [pscustomobject]@{ Stopped = $false; Reason = "dry_run"; Pid = $lock.Pid }
    }

    Stop-Process -Id $lock.Pid -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds([Math]::Max(0, $WaitSeconds))
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        if (-not (Test-CodexMainlineProcessAlive -PidValue $lock.Pid)) {
            Remove-CodexMainlineStaleLock -Paths $Paths | Out-Null
            Remove-Item -LiteralPath $Paths.ReadyPath -Force -ErrorAction SilentlyContinue
            return [pscustomobject]@{ Stopped = $true; Reason = "stopped"; Pid = $lock.Pid }
        }
    }

    if (Test-CodexMainlineProcessAlive -PidValue $lock.Pid) {
        Stop-Process -Id $lock.Pid -Force -ErrorAction SilentlyContinue
    }
    Remove-CodexMainlineStaleLock -Paths $Paths | Out-Null
    Remove-Item -LiteralPath $Paths.ReadyPath -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ Stopped = $true; Reason = "forced"; Pid = $lock.Pid }
}

