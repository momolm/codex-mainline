param(
    [int]$InitialDelaySeconds = 10,
    [int]$StopWaitSeconds = 5,
    [string]$Reason = "self_stop_request",
    [switch]$StopWatchdog,
    [switch]$DirectStop,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    . (Join-Path $scriptDir "CodexMainlineProcess.ps1")

    $paths = Get-CodexMainlinePaths
    Write-Host "Codex Mainline shutdown requested."
    Write-CodexMainlineJsonl -Path $paths.ShutdownLog -Data ([pscustomobject]@{
        event = "shutdown_requested"
        initial_delay_seconds = $InitialDelaySeconds
        stop_wait_seconds = $StopWaitSeconds
        dry_run = [bool]$DryRun
    })

    $watchdog = Ensure-CodexMainlineWatchdog -Paths $paths -HiddenMainline -DryRun:$DryRun
    Write-Host "Watchdog preflight: alive=$($watchdog.Alive), started=$($watchdog.Started), pid=$($watchdog.Pid), reason=$($watchdog.Reason)"
    Write-CodexMainlineJsonl -Path $paths.ShutdownLog -Data ([pscustomobject]@{
        event = "watchdog_preflight"
        alive = $watchdog.Alive
        started = $watchdog.Started
        pid = $watchdog.Pid
        reason = $watchdog.Reason
        launcher_pid = $watchdog.LauncherPid
        dry_run = [bool]$DryRun
    })
    if (-not $DryRun -and -not $watchdog.Alive) {
        throw "Watchdog is not alive; refusing to stop mainline because it cannot be guaranteed to restart."
    }

    if (-not $DirectStop) {
        if (-not $DryRun -and (Test-Path -LiteralPath $paths.DisableMarker)) {
            throw "Watchdog is disabled by marker; refusing to queue a self-stop request because restart cannot be guaranteed."
        }

        $requestAction = if ($StopWatchdog) { "shutdown_mainline_and_watchdog" } else { "restart_mainline" }
        $request = [ordered]@{
            schema_version = 1
            request_id = [guid]::NewGuid().ToString()
            action = $requestAction
            requested_at = (Get-Date).ToUniversalTime().ToString("o")
            requested_by_pid = $PID
            initial_delay_seconds = [Math]::Max(0, $InitialDelaySeconds)
            stop_wait_seconds = [Math]::Max(0, $StopWaitSeconds)
            reason = $Reason
        }

        if (-not $DryRun) {
            Write-CodexMainlineJson -Path $paths.RestartRequestPath -Data $request
        }
        Write-CodexMainlineJsonl -Path $paths.ShutdownLog -Data ([pscustomobject]@{
            event = "restart_request_queued"
            request_id = $request.request_id
            request_path = $paths.RestartRequestPath
            initial_delay_seconds = $request.initial_delay_seconds
            stop_wait_seconds = $request.stop_wait_seconds
            reason = $request.reason
            dry_run = [bool]$DryRun
        })
        if ($StopWatchdog) {
            Write-Host "Codex Mainline shutdown-all request queued for watchdog execution."
        } else {
            Write-Host "Codex Mainline restart request queued for watchdog execution."
        }
        Write-Host "request_id=$($request.request_id), delay=$($request.initial_delay_seconds)s, stop_wait=$($request.stop_wait_seconds)s"
        return
    }

    if ($InitialDelaySeconds -gt 0) {
        Write-Host "Waiting $InitialDelaySeconds seconds before stopping mainline..."
        Start-Sleep -Seconds $InitialDelaySeconds
    }

    if (-not $DryRun) {
        $now = (Get-Date).ToUniversalTime().ToString("o")
        Set-Content -LiteralPath $paths.ShutdownMarker -Value $now -Encoding UTF8
    }

    $stopResult = Stop-CodexMainlineNodeProcess -Paths $paths -WaitSeconds $StopWaitSeconds -DryRun:$DryRun
    Write-Host "Stop result: pid=$($stopResult.Pid), reason=$($stopResult.Reason), stopped=$($stopResult.Stopped)"
    Write-CodexMainlineJsonl -Path $paths.ShutdownLog -Data ([pscustomobject]@{
        event = "mainline_stop_result"
        pid = $stopResult.Pid
        reason = $stopResult.Reason
        stopped = $stopResult.Stopped
    })

    $activeCleared = $false
    if (-not $DryRun) {
        $activeCleared = Clear-CodexMainlineActiveState -Paths $paths -Reason "shutdown_cleanup"
    }
    Write-Host "Active state cleanup changed=$activeCleared"
    Write-CodexMainlineJsonl -Path $paths.ShutdownLog -Data ([pscustomobject]@{
        event = "active_state_cleanup"
        changed = $activeCleared
        skipped = [bool]$DryRun
    })

    if (-not $DryRun) {
        Start-Sleep -Seconds 5
        Remove-Item -LiteralPath $paths.ShutdownMarker -Force -ErrorAction SilentlyContinue
    }

    Write-CodexMainlineJsonl -Path $paths.ShutdownLog -Data ([pscustomobject]@{
        event = "shutdown_script_exit"
        dry_run = [bool]$DryRun
    })
    Write-Host "Codex Mainline shutdown script finished. Watchdog will restart mainline if it is enabled."
}
catch {
    Write-Host ""
    Write-Host "Codex Mainline shutdown script failed:" -ForegroundColor Red
    Write-Host ($_ | Out-String)
    Write-Host "Press any key to close this window..."
    [void][Console]::ReadKey($true)
    exit 1
}

