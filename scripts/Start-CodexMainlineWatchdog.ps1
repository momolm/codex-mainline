param(
    [int]$CheckIntervalSeconds = 10,
    [int]$MissingThresholdSeconds = 10,
    [int]$HeartbeatPrintSeconds = 300,
    [switch]$HiddenWatchdog,
    [switch]$HiddenMainline,
    [switch]$VisibleWatchdog,
    [switch]$VisibleMainline,
    [switch]$Once,
    [switch]$KeepRhythm,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $workspaceRoot = Resolve-Path (Join-Path $scriptDir "..")
    $watchScript = Join-Path $scriptDir "Watch-CodexMainline.ps1"
    . (Join-Path $scriptDir "CodexMainlineProcess.ps1")
    $paths = Get-CodexMainlinePaths
    if (-not (Test-Path -LiteralPath $paths.RuntimeDir)) {
        New-Item -ItemType Directory -Path $paths.RuntimeDir -Force | Out-Null
    }

    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    $shell = if ($pwsh) { $pwsh.Source } else { "powershell.exe" }
    $effectiveHiddenWatchdog = -not [bool]$VisibleWatchdog
    if ($HiddenWatchdog) {
        $effectiveHiddenWatchdog = $true
    }
    $effectiveHiddenMainline = -not [bool]$VisibleMainline
    if ($HiddenMainline) {
        $effectiveHiddenMainline = $true
    }

    $argsList = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $watchScript,
        "-CheckIntervalSeconds", "$CheckIntervalSeconds",
        "-MissingThresholdSeconds", "$MissingThresholdSeconds",
        "-HeartbeatPrintSeconds", "$HeartbeatPrintSeconds"
    )
    if ($effectiveHiddenMainline) {
        $argsList += "-HiddenMainline"
    }
    if ($Once) {
        $argsList += "-Once"
    }
    if ($KeepRhythm) {
        $argsList += "-KeepRhythm"
    }
    if ($DryRun) {
        $argsList += "-DryRun"
    }

    if (-not $DryRun -and (Test-CodexMainlineWatchdogAvailable -Paths $paths)) {
        $existing = Get-CodexMainlineWatchdogLock -Paths $paths
        Write-Host "Codex Mainline watchdog already running: pid=$($existing.Pid). Launcher will not start another instance."
        Write-CodexMainlineJsonl -Path $paths.KeepaliveLog -Data ([pscustomobject]@{
            event = "watchdog_launcher_skipped_existing"
            existing_pid = $existing.Pid
            current_pid = $PID
        })
        exit 0
    }

    if ($DryRun) {
        & $watchScript `
            -CheckIntervalSeconds $CheckIntervalSeconds `
            -MissingThresholdSeconds $MissingThresholdSeconds `
            -HeartbeatPrintSeconds $HeartbeatPrintSeconds `
            -HiddenMainline:$effectiveHiddenMainline `
            -Once `
            -KeepRhythm:$KeepRhythm `
            -DryRun
    } elseif (-not $effectiveHiddenWatchdog) {
        & $watchScript `
            -CheckIntervalSeconds $CheckIntervalSeconds `
            -MissingThresholdSeconds $MissingThresholdSeconds `
            -HeartbeatPrintSeconds $HeartbeatPrintSeconds `
            -HiddenMainline:$effectiveHiddenMainline `
            -Once:$Once `
            -KeepRhythm:$KeepRhythm `
            -DryRun:$DryRun
    } else {
        Start-Process `
            -FilePath $shell `
            -ArgumentList $argsList `
            -WorkingDirectory $workspaceRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $paths.RuntimeDir "watchdog.stdout.log") `
            -RedirectStandardError (Join-Path $paths.RuntimeDir "watchdog.stderr.log")
    }
}
catch {
    Write-Host ""
    Write-Host "Codex Mainline watchdog launcher failed:" -ForegroundColor Red
    Write-Host ($_ | Out-String)
    Write-Host "Press any key to close this window..."
    [void][Console]::ReadKey($true)
    exit 1
}
