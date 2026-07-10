---
name: effort
description: Use during sustained work in Codex Mainline when the current main context decides that a meaningful work phase needs a persistent high, xhigh, or max reasoning level. Submit a same-thread shift and continuation request; user-controlled changes remain available through /effort.
---

# Effort

Drive Codex Mainline's persistent reasoning gear during sustained work. The current main context makes the semantic decision; the outer program only carries the explicit request.

The work stays in the same main context and thread throughout the shift.

## Choose A Gear

- `high`: the plan and boundaries are clear, with sustained implementation or verification ahead.
- `xhigh`: default cruise for most engineering judgment and maintenance.
- `max`: architecture problems, conflicting evidence, high-risk changes, or difficult root-cause analysis.

Shift when the work enters a meaningfully different phase. Keep the current gear for a short remaining action or near task completion. `ultra` stays outside this workflow.

## Shift

Run from the Codex Mainline working directory:

```powershell
pwsh -NoProfile -File .\scripts\Request-CodexMainlineEffortShift.ps1 -Effort <level>
```

After a successful submission:

1. Leave the current task at a concise, recoverable checkpoint.
2. End the current turn without starting more substantive work.
3. Let Codex Mainline persist the target gear and continue the same thread.

The producer accepts requests from the active Codex Mainline thread. Other Codex surfaces continue normally without submitting a request.

## Cancel

When the user redirects or stops the work after submission and before the turn ends, run:

```powershell
pwsh -NoProfile -File .\scripts\Request-CodexMainlineEffortShift.ps1 -Cancel
```

The user's `/effort` command has priority and clears a pending autonomous shift.
