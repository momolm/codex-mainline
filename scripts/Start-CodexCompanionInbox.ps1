param(
    [switch]$DryRun,
    [switch]$Once,
    [string]$Config = "config/companion-inbox.settings.json"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Resolve-Path (Join-Path $scriptDir "..")
$nodeScript = Join-Path $workspaceRoot "src\start-codex-companion-inbox.mjs"
$argsList = @($nodeScript, "--config", $Config)
if ($DryRun) { $argsList += "--dry-run" }
if ($Once) { $argsList += "--once" }

Push-Location $workspaceRoot
try {
    & node @argsList
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
