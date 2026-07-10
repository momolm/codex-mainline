[CmdletBinding(DefaultParameterSetName = "Request")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Request")]
    [string]$Effort,
    [Parameter(Mandatory = $true, ParameterSetName = "Cancel")]
    [switch]$Cancel,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    . (Join-Path $scriptDir "CodexMainlineProcess.ps1")

    $paths = Get-CodexMainlinePaths
    $state = Read-CodexMainlineJson -Path $paths.StatePath
    $callerThreadId = [string]$env:CODEX_THREAD_ID
    if ([string]::IsNullOrWhiteSpace($callerThreadId)) {
        throw "CODEX_THREAD_ID is unavailable; this request is limited to a live Codex thread."
    }
    if ($null -eq $state -or [string]::IsNullOrWhiteSpace([string]$state.thread_id)) {
        throw "Codex Mainline has no bound thread."
    }
    if ($callerThreadId -ne [string]$state.thread_id) {
        throw "Current Codex thread does not match the Codex Mainline thread."
    }

    if ($Cancel) {
        $pending = Read-CodexMainlineJson -Path $paths.TurnRequestPath
        if ($null -eq $pending) {
            Write-Host "No pending effort shift request."
            exit 0
        }
        if (-not $DryRun) {
            Remove-Item -LiteralPath $paths.TurnRequestPath -Force
        }
        Write-CodexMainlineJsonl -Path $paths.TurnRequestLog -Data ([pscustomobject]@{
            event = "effort_shift_cancelled_by_skill"
            request_id = $pending.request_id
            thread_id = $pending.thread_id
            origin_turn_id = $pending.origin_turn_id
            effort = $pending.effort
            dry_run = [bool]$DryRun
        })
        Write-Host "Pending effort shift request cancelled."
        exit 0
    }

    $mainline = Get-CodexMainlineProcessLock -Paths $paths
    if (-not $mainline.Alive) {
        throw "Codex Mainline is not alive."
    }
    if ([string]::IsNullOrWhiteSpace([string]$state.active_turn_id)) {
        throw "Codex Mainline has no active turn to bind this effort shift request."
    }

    $targetEffort = $Effort.Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($targetEffort)) {
        throw "Effort is empty."
    }

    $settings = Read-CodexMainlineJson -Path $paths.SettingsPath
    if ([string]$settings.effort -eq $targetEffort) {
        Write-Host "Effort is already set to $targetEffort; no shift request created."
        exit 0
    }

    $pending = Read-CodexMainlineJson -Path $paths.TurnRequestPath
    if ($null -ne $pending) {
        $sameRequest = (
            [string]$pending.action -eq "set_effort_and_continue" -and
            [string]$pending.thread_id -eq [string]$state.thread_id -and
            [string]$pending.origin_turn_id -eq [string]$state.active_turn_id -and
            [string]$pending.effort -eq $targetEffort
        )
        if ($sameRequest) {
            Write-Host "The same effort shift request is already pending."
            Write-Host "request_id=$($pending.request_id)"
            exit 0
        }
        throw "Another Codex Mainline turn request is already pending."
    }

    $request = [ordered]@{
        schema_version = 1
        request_id = [guid]::NewGuid().ToString()
        action = "set_effort_and_continue"
        requested_at = (Get-Date).ToUniversalTime().ToString("o")
        requested_by_pid = $PID
        effort = $targetEffort
        thread_id = [string]$state.thread_id
        origin_turn_id = [string]$state.active_turn_id
    }

    if (-not $DryRun) {
        Write-CodexMainlineJson -Path $paths.TurnRequestPath -Data $request
    }
    Write-CodexMainlineJsonl -Path $paths.TurnRequestLog -Data ([pscustomobject]@{
        event = "effort_shift_requested"
        request_id = $request.request_id
        thread_id = $request.thread_id
        origin_turn_id = $request.origin_turn_id
        effort = $request.effort
        dry_run = [bool]$DryRun
    })

    Write-Host "Codex Mainline effort shift request prepared."
    Write-Host "request_id=$($request.request_id)"
    Write-Host "thread_id=$($request.thread_id)"
    Write-Host "origin_turn_id=$($request.origin_turn_id)"
    Write-Host "effort=$($request.effort)"
    if ($DryRun) {
        Write-Host "Dry run only: no request file was written."
    } else {
        Write-Host "Finish the current turn at a recoverable checkpoint; Codex Mainline will shift effort and continue after normal completion."
    }
} catch {
    Write-Host ""
    Write-Host "Codex Mainline effort shift request failed:" -ForegroundColor Red
    Write-Host ($_ | Out-String)
    exit 1
}
