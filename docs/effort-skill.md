# Persistent Effort Skill

Codex Mainline includes an optional `$effort` skill for persistent, model-driven reasoning shifts during sustained work.

## Behavior

- The active Codex context chooses `high`, `xhigh`, or `max` when a meaningful work phase changes.
- The producer binds the request to the current `thread_id` and active turn.
- After the origin turn completes normally, Codex Mainline validates the target against the selected model's live reasoning-level catalog.
- Codex Mainline starts one same-thread continuation at the target effort and persists that effort in settings.
- `/effort` and `/stop` clear a pending autonomous shift.
- Compaction recovery and protected input replay keep priority over effort continuation.

The bridge code does not maintain an effort-level allowlist. The three named gears are guidance for the skill; runtime support comes from Codex's local model cache.

## Install

Copy the bundled skill into the active Codex home:

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$skillsDir = Join-Path $codexHome "skills"
New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null
Copy-Item .\skills\effort -Destination $skillsDir -Recurse -Force
```

Start a new Codex thread after installation so its skill catalog includes `$effort`. Existing threads can continue to use `/effort` directly.

## Direct Producer Use

The installed skill calls:

```powershell
pwsh -NoProfile -File .\scripts\Request-CodexMainlineEffortShift.ps1 -Effort max
```

Validate the active thread binding without writing a request:

```powershell
pwsh -NoProfile -File .\scripts\Request-CodexMainlineEffortShift.ps1 -Effort max -DryRun
```

Cancel a pending request:

```powershell
pwsh -NoProfile -File .\scripts\Request-CodexMainlineEffortShift.ps1 -Cancel
```

Runtime evidence is stored under `runtime/tg_mainline/turn_requests.jsonl`. The pending request file is `runtime/tg_mainline/turn.request.json`.
