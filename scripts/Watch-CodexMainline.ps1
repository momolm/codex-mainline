param(
    [int]$CheckIntervalSeconds = 10,
    [int]$MissingThresholdSeconds = 10,
    [int]$NotReadyThresholdSeconds = 90,
    [int]$HeartbeatPrintSeconds = 300,
    [string]$WakeMessage = "【Codex Mainline】: Knock knock. Watchdog restarted the mainline; continue the current task if needed.",
    [switch]$Once,
    [switch]$HiddenMainline,
    [switch]$VisibleMainline,
    [switch]$KeepRhythm,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$instanceLock = $null

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    . (Join-Path $scriptDir "CodexMainlineProcess.ps1")

    $paths = Get-CodexMainlinePaths
    if (-not $DryRun) {
        $existingWatchdog = Get-CodexMainlineWatchdogLock -Paths $paths
        if ($existingWatchdog.Alive -and $existingWatchdog.Pid -ne $PID) {
            Write-Host "Codex Mainline watchdog already running: pid=$($existingWatchdog.Pid). This instance will exit."
            Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                event = "watchdog_duplicate_exit"
                existing_pid = $existingWatchdog.Pid
                current_pid = $PID
                reason = "state_lock_alive"
            })
            exit 0
        }
    }

    $instanceLock = Acquire-CodexMainlineWatchdogInstanceLock -Paths $paths -DryRun:$DryRun
    if (-not $instanceLock.Acquired) {
        Write-Host "Codex Mainline watchdog instance lock is held. This instance will exit. existing_pid=$($instanceLock.ExistingPid)"
        Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
            event = "watchdog_duplicate_exit"
            existing_pid = $instanceLock.ExistingPid
            existing_alive = $instanceLock.ExistingAlive
            current_pid = $PID
            reason = $instanceLock.Reason
        })
        exit 0
    }

    $effectiveHiddenMainline = -not [bool]$VisibleMainline
    if ($HiddenMainline) {
        $effectiveHiddenMainline = $true
    }

    $rhythmReset = [pscustomobject]@{
        Changed = $false
        SettingsChanged = $false
        StateChanged = $false
        Reason = "kept"
    }
    if (-not $KeepRhythm) {
        $rhythmReset = Disable-CodexMainlineRhythm -Paths $paths -Reason "watchdog_start_default_off" -DryRun:$DryRun
    }

    $missingSince = $null
    $notReadySince = $null
    $notReadyPid = $null
    $lastAlivePrintedAt = $null
    $lastAlivePid = $null
    $lastShutdownMarkerPrintedAt = $null
    $lastRestartRequestPrintedAt = $null

    Write-Host "Codex Mainline watchdog started. check=$CheckIntervalSeconds seconds, missing_threshold=$MissingThresholdSeconds seconds, not_ready_threshold=$NotReadyThresholdSeconds seconds, heartbeat=$HeartbeatPrintSeconds seconds, hidden_mainline=$effectiveHiddenMainline."
    Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
        event = "watchdog_started"
        instance_lock_path = $instanceLock.Path
        check_interval_seconds = $CheckIntervalSeconds
        missing_threshold_seconds = $MissingThresholdSeconds
        not_ready_threshold_seconds = $NotReadyThresholdSeconds
        heartbeat_print_seconds = $HeartbeatPrintSeconds
        wake_message = $WakeMessage
        once = [bool]$Once
        hidden_mainline = [bool]$effectiveHiddenMainline
        keep_rhythm = [bool]$KeepRhythm
        rhythm_reset_changed = [bool]$rhythmReset.Changed
        rhythm_settings_changed = [bool]$rhythmReset.SettingsChanged
        rhythm_state_changed = [bool]$rhythmReset.StateChanged
        dry_run = [bool]$DryRun
    })

    while ($true) {
        if (-not $DryRun) {
            Update-CodexMainlineWatchdogLock -Paths $paths -CheckIntervalSeconds $CheckIntervalSeconds -HiddenMainline:$effectiveHiddenMainline
        }

        if (Test-Path -LiteralPath $paths.DisableMarker) {
            Write-Host "Watchdog disabled by marker: $($paths.DisableMarker)"
            Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                event = "watchdog_disabled"
                marker = $paths.DisableMarker
            })
            if ($Once) { break }
            Start-Sleep -Seconds $CheckIntervalSeconds
            continue
        }

        if (Test-Path -LiteralPath $paths.ShutdownMarker) {
            $rawMarker = Get-Content -LiteralPath $paths.ShutdownMarker -Raw -ErrorAction SilentlyContinue
            $markerTime = [datetime]::MinValue
            $parsedMarker = [datetime]::TryParse(([string]$rawMarker).Trim(), [ref]$markerTime)
            if (-not $parsedMarker) {
                $markerItem = Get-Item -LiteralPath $paths.ShutdownMarker -ErrorAction SilentlyContinue
                if ($markerItem) {
                    $markerTime = $markerItem.LastWriteTimeUtc
                    $parsedMarker = $true
                }
            }
            $ageSeconds = if ($parsedMarker) { ((Get-Date).ToUniversalTime() - $markerTime.ToUniversalTime()).TotalSeconds } else { 0 }
            if ($parsedMarker -and $ageSeconds -gt 120) {
                Remove-Item -LiteralPath $paths.ShutdownMarker -Force -ErrorAction SilentlyContinue
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] stale shutdown marker removed after $([Math]::Round($ageSeconds, 1)) seconds."
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "shutdown_marker_stale_removed"
                    marker = $paths.ShutdownMarker
                    age_seconds = [Math]::Round($ageSeconds, 3)
                })
            } else {
                $now = Get-Date
                $shouldPrintShutdown = $Once -or ($null -eq $lastShutdownMarkerPrintedAt) -or (($now - $lastShutdownMarkerPrintedAt).TotalSeconds -ge $HeartbeatPrintSeconds)
                if ($shouldPrintShutdown) {
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] shutdown marker present; waiting for self-stop cleanup."
                    $lastShutdownMarkerPrintedAt = $now
                }
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "shutdown_in_progress"
                    marker = $paths.ShutdownMarker
                    age_seconds = [Math]::Round($ageSeconds, 3)
                })
                $missingSince = $null
                if ($Once) { break }
                Start-Sleep -Seconds $CheckIntervalSeconds
                continue
            }
        }

        if (Test-Path -LiteralPath $paths.RestartRequestPath) {
            $request = Read-CodexMainlineJson -Path $paths.RestartRequestPath
            $validRequestActions = @("restart_mainline", "shutdown_mainline_and_watchdog")
            if ($null -eq $request -or $validRequestActions -notcontains ([string]$request.action)) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] invalid restart request removed: $($paths.RestartRequestPath)"
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "restart_request_invalid_removed"
                    request_path = $paths.RestartRequestPath
                    action = if ($null -ne $request) { $request.action } else { $null }
                })
                Remove-Item -LiteralPath $paths.RestartRequestPath -Force -ErrorAction SilentlyContinue
                if ($Once) { break }
                Start-Sleep -Seconds $CheckIntervalSeconds
                continue
            }

            $requestedAt = [datetime]::MinValue
            $parsedRequestedAt = [datetime]::TryParse([string]$request.requested_at, [ref]$requestedAt)
            if (-not $parsedRequestedAt) {
                $requestItem = Get-Item -LiteralPath $paths.RestartRequestPath -ErrorAction SilentlyContinue
                if ($requestItem) {
                    $requestedAt = $requestItem.LastWriteTimeUtc
                    $parsedRequestedAt = $true
                }
            }
            if (-not $parsedRequestedAt) {
                $requestedAt = (Get-Date).ToUniversalTime()
            }

            $delayRaw = if ($null -ne $request.initial_delay_seconds) { $request.initial_delay_seconds } else { 0 }
            $stopWaitRaw = if ($null -ne $request.stop_wait_seconds) { $request.stop_wait_seconds } else { 5 }
            $delaySeconds = [Math]::Max(0, [int]$delayRaw)
            $stopWaitSeconds = [Math]::Max(0, [int]$stopWaitRaw)
            $requestId = if ($request.request_id) { [string]$request.request_id } else { "(missing)" }
            $requestAction = if ($request.action) { [string]$request.action } else { "restart_mainline" }
            $stopWatchdogAfterMainline = $requestAction -eq "shutdown_mainline_and_watchdog"
            $dueAt = $requestedAt.ToUniversalTime().AddSeconds($delaySeconds)
            $secondsUntilDue = ($dueAt - (Get-Date).ToUniversalTime()).TotalSeconds
            if ($secondsUntilDue -gt 0) {
                $now = Get-Date
                $shouldPrintRestartPending = $Once -or ($null -eq $lastRestartRequestPrintedAt) -or (($now - $lastRestartRequestPrintedAt).TotalSeconds -ge $HeartbeatPrintSeconds)
                if ($shouldPrintRestartPending) {
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] request pending: action=$requestAction, request_id=$requestId, due_in=$([Math]::Round($secondsUntilDue, 1))s"
                    $lastRestartRequestPrintedAt = $now
                }
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "restart_request_pending"
                    request_id = $requestId
                    action = $requestAction
                    due_in_seconds = [Math]::Round($secondsUntilDue, 3)
                })
                if ($Once) { break }
                Start-Sleep -Seconds ([Math]::Min($CheckIntervalSeconds, [Math]::Max(1, [int][Math]::Ceiling($secondsUntilDue))))
                continue
            }

            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] request due: action=$requestAction, request_id=$requestId."
            Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                event = "restart_request_due"
                request_id = $requestId
                action = $requestAction
                delay_seconds = $delaySeconds
                stop_wait_seconds = $stopWaitSeconds
                reason = $request.reason
            })

            if (-not $DryRun) {
                Set-Content -LiteralPath $paths.ShutdownMarker -Value ((Get-Date).ToUniversalTime().ToString("o")) -Encoding UTF8
            }
            $stopResult = Stop-CodexMainlineNodeProcess -Paths $paths -WaitSeconds $stopWaitSeconds -DryRun:$DryRun
            Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                event = "restart_request_stop_result"
                request_id = $requestId
                action = $requestAction
                pid = $stopResult.Pid
                reason = $stopResult.Reason
                stopped = $stopResult.Stopped
            })
            $activeCleared = $false
            if (-not $DryRun) {
                $activeCleared = Clear-CodexMainlineActiveState -Paths $paths -Reason "watchdog_restart_request"
                Remove-Item -LiteralPath $paths.ShutdownMarker -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $paths.RestartRequestPath -Force -ErrorAction SilentlyContinue
            }

            if ($stopWatchdogAfterMainline) {
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "shutdown_all_request_watchdog_exit"
                    request_id = $requestId
                    active_state_cleared = $activeCleared
                    dry_run = [bool]$DryRun
                })
                $missingSince = $null
                $notReadySince = $null
                $notReadyPid = $null
                break
            }

            $process = Start-CodexMainlineNodeProcess -Paths $paths -Hidden:$effectiveHiddenMainline -WakeMessage $WakeMessage -DryRun:$DryRun
            $startResult = if ($DryRun) {
                [pscustomobject]@{ Started = $false; Pid = $null; Reason = "dry_run" }
            } else {
                Wait-CodexMainlineStarted -Paths $paths -TimeoutSeconds 60
            }
            Write-Host "Restart request result: started=$($startResult.Started), pid=$($startResult.Pid), reason=$($startResult.Reason)"
            Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                event = "restart_request_restart_result"
                request_id = $requestId
                active_state_cleared = $activeCleared
                launcher_pid = if ($process) { $process.Id } else { $null }
                started = $startResult.Started
                mainline_pid = $startResult.Pid
                start_reason = $startResult.Reason
                wake_message_requested = -not [string]::IsNullOrWhiteSpace($WakeMessage)
                dry_run = [bool]$DryRun
            })
            $missingSince = $null
            $notReadySince = $null
            $notReadyPid = $null
            if ($Once) { break }
            Start-Sleep -Seconds $CheckIntervalSeconds
            continue
        }

        $lock = Get-CodexMainlineProcessLock -Paths $paths
        if ($lock.Alive) {
            $ready = Get-CodexMainlineReady -Paths $paths
            $now = Get-Date
            $heartbeatDue = $false
            if ($HeartbeatPrintSeconds -gt 0) {
                $heartbeatDue = $null -eq $lastAlivePrintedAt -or (($now - $lastAlivePrintedAt).TotalSeconds -ge $HeartbeatPrintSeconds)
            }
            $shouldPrintAlive = $Once -or ($null -ne $missingSince) -or ($lastAlivePid -ne $lock.Pid) -or $heartbeatDue
            if ($shouldPrintAlive) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] mainline alive: pid=$($lock.Pid)"
                $lastAlivePrintedAt = $now
                $lastAlivePid = $lock.Pid
            }
            Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                event = "mainline_alive"
                pid = $lock.Pid
                started_at = $lock.StartedAt
                ready = ($ready.Ready -and $ready.Pid -eq $lock.Pid)
                ready_at = $ready.ReadyAt
                endpoint = $ready.Endpoint
            })
            if ($ready.Ready -and $ready.Pid -eq $lock.Pid) {
                $notReadySince = $null
                $notReadyPid = $null
            } else {
                if ($null -eq $notReadySince -or $notReadyPid -ne $lock.Pid) {
                    $notReadySince = Get-Date
                    $notReadyPid = $lock.Pid
                    Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                        event = "mainline_not_ready"
                        pid = $lock.Pid
                        threshold_seconds = $NotReadyThresholdSeconds
                    })
                }
                $notReadySeconds = ((Get-Date) - $notReadySince).TotalSeconds
                if ($notReadySeconds -ge $NotReadyThresholdSeconds) {
                    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] mainline pid=$($lock.Pid) stayed not-ready for $([Math]::Round($notReadySeconds, 1)) seconds. Restarting..."
                    $stopResult = Stop-CodexMainlineNodeProcess -Paths $paths -WaitSeconds 5 -DryRun:$DryRun
                    Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                        event = "mainline_not_ready_stop_result"
                        pid = $stopResult.Pid
                        reason = $stopResult.Reason
                        stopped = $stopResult.Stopped
                        not_ready_seconds = [Math]::Round($notReadySeconds, 3)
                    })
                    $activeCleared = $false
                    if (-not $DryRun) {
                        $activeCleared = Clear-CodexMainlineActiveState -Paths $paths -Reason "keepalive_not_ready_restart"
                    }
                    $process = Start-CodexMainlineNodeProcess -Paths $paths -Hidden:$effectiveHiddenMainline -WakeMessage $WakeMessage -DryRun:$DryRun
                    $startResult = if ($DryRun) {
                        [pscustomobject]@{ Started = $false; Pid = $null; Reason = "dry_run" }
                    } else {
                        Wait-CodexMainlineStarted -Paths $paths -TimeoutSeconds 60
                    }
                    Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                        event = "mainline_not_ready_restart_requested"
                        active_state_cleared = $activeCleared
                        launcher_pid = if ($process) { $process.Id } else { $null }
                        started = $startResult.Started
                        mainline_pid = $startResult.Pid
                        start_reason = $startResult.Reason
                        dry_run = [bool]$DryRun
                    })
                    $missingSince = $null
                    $notReadySince = $null
                    $notReadyPid = $null
                    if ($Once) { break }
                    Start-Sleep -Seconds $CheckIntervalSeconds
                    continue
                }
            }
            if ($null -ne $missingSince) {
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "mainline_recovered_before_restart"
                    pid = $lock.Pid
                })
            }
            $missingSince = $null
        } else {
            if ($null -eq $missingSince) {
                $missingSince = Get-Date
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] mainline missing. Waiting before restart..."
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "mainline_missing"
                    lock_exists = $lock.Exists
                    pid = $lock.Pid
                })
            }

            $missingSeconds = ((Get-Date) - $missingSince).TotalSeconds
            if ($missingSeconds -ge $MissingThresholdSeconds) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] mainline missing for $([Math]::Round($missingSeconds, 1)) seconds. Restarting..."
                Remove-CodexMainlineStaleLock -Paths $paths | Out-Null
                $activeCleared = $false
                if (-not $DryRun) {
                    $activeCleared = Clear-CodexMainlineActiveState -Paths $paths -Reason "keepalive_restart_cleanup"
                }
                $process = Start-CodexMainlineNodeProcess -Paths $paths -Hidden:$effectiveHiddenMainline -WakeMessage $WakeMessage -DryRun:$DryRun
                $startResult = if ($DryRun) {
                    [pscustomobject]@{ Started = $false; Pid = $null; Reason = "dry_run" }
                } else {
                    Wait-CodexMainlineStarted -Paths $paths -TimeoutSeconds 30
                }
                Write-Host "Restart result: started=$($startResult.Started), pid=$($startResult.Pid), reason=$($startResult.Reason)"
                Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
                    event = "mainline_restart_requested"
                    missing_seconds = [Math]::Round($missingSeconds, 3)
                    active_state_cleared = $activeCleared
                    active_state_cleanup_skipped = [bool]$DryRun
                    launcher_pid = if ($process) { $process.Id } else { $null }
                    started = $startResult.Started
                    mainline_pid = $startResult.Pid
                    start_reason = $startResult.Reason
                    wake_message_requested = -not [string]::IsNullOrWhiteSpace($WakeMessage)
                    dry_run = [bool]$DryRun
                })
                $missingSince = $null
            }
        }

        if ($Once) { break }
        Start-Sleep -Seconds $CheckIntervalSeconds
    }

    Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
        event = "watchdog_exit"
        dry_run = [bool]$DryRun
    })
    if (-not $DryRun) {
        Remove-Item -LiteralPath $paths.WatchdogLockPath -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Codex Mainline watchdog exited."
}
catch {
    Write-Host ""
    Write-Host "Codex Mainline watchdog failed:" -ForegroundColor Red
    Write-Host ($_ | Out-String)
    Write-Host "Press any key to close this window..."
    [void][Console]::ReadKey($true)
    exit 1
}
finally {
    Release-CodexMainlineWatchdogInstanceLock -InstanceLock $instanceLock
}

