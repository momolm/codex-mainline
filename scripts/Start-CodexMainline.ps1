param(
    [switch]$DryRun,
    [switch]$Once,
    [switch]$Wake,
    [string]$StartupMessage,
    [switch]$DebugRaw
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Resolve-Path (Join-Path $scriptDir "..")
$nodeScript = Join-Path $workspaceRoot "src\start-codex-mainline.mjs"

$argsList = @($nodeScript)
if ($DryRun) { $argsList += "--dry-run" }
if ($Once) { $argsList += "--once" }
if ($Wake) { $argsList += "--wake" }
if (-not [string]::IsNullOrWhiteSpace($StartupMessage)) {
    $argsList += "--startup-message"
    $argsList += $StartupMessage
}
if ($DebugRaw) { $argsList += "--debug-raw" }

Push-Location $workspaceRoot
try {
    & node @argsList
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
