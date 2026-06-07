param(
    [switch]$Remove,
    [switch]$VisibleMainline,
    [switch]$KeepRhythm,
    [switch]$UseScheduledTask,
    [string]$TaskName = "CodexMainlineWatchdogStartup",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $workspaceRoot = Resolve-Path (Join-Path $scriptDir "..")
    $launcher = Join-Path $scriptDir "Start-CodexMainlineWatchdog.ps1"
    $startupDir = [Environment]::GetFolderPath("Startup")
    if ([string]::IsNullOrWhiteSpace($startupDir)) {
        throw "Windows Startup folder is unavailable for this user."
    }
    $startupPath = Join-Path $startupDir "CodexMainlineWatchdogStartup.vbs"

    if (-not (Test-Path -LiteralPath $launcher)) {
        throw "Missing launcher: $launcher"
    }

    if ($Remove) {
        if ($DryRun) {
            Write-Host "Would remove startup entry: $startupPath"
            Write-Host "Would remove scheduled task: $TaskName"
        } else {
            Remove-Item -LiteralPath $startupPath -Force -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
            Write-Host "Removed startup entry: $startupPath"
            Write-Host "Removed scheduled task if present: $TaskName"
        }
        exit 0
    }

    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    $shell = if ($pwsh) { $pwsh.Source } else { (Get-Command powershell.exe -ErrorAction Stop).Source }
    $argumentParts = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$launcher`""
    )
    if ($VisibleMainline) {
        $argumentParts += "-VisibleMainline"
    }
    if ($KeepRhythm) {
        $argumentParts += "-KeepRhythm"
    }

    if ($UseScheduledTask) {
        $arguments = $argumentParts -join " "
        $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

        if ($DryRun) {
            Write-Host "Would register elevated scheduled task: $TaskName"
            Write-Host "User: $userId"
            Write-Host "Execute: $shell"
            Write-Host "Arguments: $arguments"
            Write-Host "WorkingDirectory: $($workspaceRoot.Path)"
            Write-Host "Would remove legacy startup entry: $startupPath"
        } else {
            $action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $workspaceRoot.Path
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
            $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
            $settings = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
                -MultipleInstances IgnoreNew
            Register-ScheduledTask `
                -TaskName $TaskName `
                -Action $action `
                -Trigger $trigger `
                -Principal $principal `
                -Settings $settings `
                -Description "Start Codex Mainline watchdog at logon with highest privileges." `
                -Force | Out-Null
            Remove-Item -LiteralPath $startupPath -Force -ErrorAction SilentlyContinue
            Write-Host "Installed elevated scheduled task: $TaskName"
            Write-Host "Removed legacy startup entry: $startupPath"
        }
        exit 0
    }

    $commandParts = @(
        "`"$shell`""
    ) + $argumentParts
    $command = $commandParts -join " "
    $escapedCommand = $command -replace '"', '""'
    $content = @"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$($workspaceRoot.Path -replace '"', '""')"
shell.Run "$escapedCommand", 0, False
"@

    if ($DryRun) {
        Write-Host "Would write startup entry: $startupPath"
        Write-Host $command
    } else {
        if (-not (Test-Path -LiteralPath $startupDir)) {
            New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
        }
        Set-Content -LiteralPath $startupPath -Value $content -Encoding ASCII
        Write-Host "Installed startup entry: $startupPath"
    }
} catch {
    Write-Error $_
    exit 1
}
