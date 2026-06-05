# Codex Field Inheritance

This note is a public-safe field guide for turning a one-off Codex helper into a durable collaboration workspace.

The core idea is simple: keep the runtime thin, keep stable context on disk, and leave a clear path for the next session to continue.

## Minimal Field

Start with a small directory:

```text
codex_field/
  README.md
  memory/
    memory.md
    archive/
  handoff/
    handoff.md
    archive/
  todo/
    TODO.md
    archive/
  docs/
  tools/
  autonomy/
    meta_goals.md
    work_policy.md
    plans/
    daily_logs/
  archive/
```

Suggested responsibilities:

- `README.md`: field entrypoint, directory map, startup read order, and operating boundary.
- `memory/memory.md`: long-term facts, preferences, decisions, boundaries, and verified procedures.
- `handoff/handoff.md`: current relay card for the next session.
- `todo/TODO.md`: active, executable work.
- `docs/`: reusable notes, designs, incident reports, and project-specific explanations.
- `tools/`: small reusable scripts and local helper notes.
- `autonomy/meta_goals.md`: long-term goals and currently active concrete goals.
- `autonomy/work_policy.md`: autonomy scope, risk levels, permissions, and verification rules.
- `autonomy/plans/`: single-task plans, usually named with `pending-`, `done-`, or `cancelled-`.
- `autonomy/daily_logs/`: short factual records of meaningful changes.
- `archive/`: old field-level material that remains useful for traceability.

## Startup Order

When a new session starts or the context feels unstable:

1. Read `README.md`.
2. Read `memory/memory.md`.
3. Read `handoff/handoff.md`.
4. If doing autonomous work, read `autonomy/meta_goals.md`, `autonomy/work_policy.md`, and relevant `autonomy/plans/`.
5. If using local helpers, read `tools/README.md` or the specific tool note first.

Old chat history is evidence, not the only source of truth. Stable conclusions should return to field files.

## Information Layers

Put each fact in the layer that matches its lifespan:

- Long-term decision or preference: `memory/memory.md`.
- Current continuation state: `handoff/handoff.md`.
- Work to execute: `todo/TODO.md` or `autonomy/plans/`.
- Reusable explanation: `docs/`.
- Reusable script or command wrapper: `tools/`.
- Daily operational fact: `autonomy/daily_logs/YYYY-MM-DD.md`.
- Old but traceable material: `archive/`.
- Temporary evidence, logs, locks, secrets, databases, and payload sidecars: runtime or ignored local paths.

## Maintenance Rules

- Archive instead of deleting durable notes, plans, handoffs, and reports.
- Keep current entrypoints short; move old detail into `archive/` with a short pointer.
- Keep `memory.md` selective. It should not become a transcript.
- Keep `handoff.md` current. It is a relay card, not the long-term memory.
- Keep `TODO.md` actionable. Completed, cancelled, or paused work should move out of the active list.
- Keep scripts small, documented, and reusable before turning them into permanent tooling.

## AGENTS-Level Rules

Good global guidance is high-level and stable:

- Default language and collaboration style.
- Field entrypoint and startup read order.
- Memory and archive policy.
- Command-output limits and search discipline.
- File safety, Git discipline, and sensitive-data boundaries.
- Natural-language control boundary: do not map ordinary prose to control flow with keyword lists or regex approximations. Reliable control should use explicit commands, buttons, protocol events, or RPCs.

Avoid putting large project logs or fast-changing facts into global agent rules.

## Small Start

A useful first version can be this small:

```text
codex_field/
  README.md
  memory/memory.md
  handoff/handoff.md
  todo/TODO.md
  tools/README.md
  archive/
```

First loop:

1. Write the field `README.md`.
2. Write a short `memory.md` with only stable facts and boundaries.
3. Write a short `handoff.md` with current goal, done work, open work, next step, and risk.
4. Write a short active `TODO.md`.
5. Do one real task.
6. Record the result in the right layer.

Add autonomy, daily logs, and richer tools after the first loop proves useful.

## Anti-Patterns

- Treating the project README as the agent's memory.
- Putting every fact into one large file.
- Treating the handoff as long-term memory.
- Deleting durable old plans and reports instead of archiving them.
- Committing raw runtime, secrets, local state, downloaded attachments, generated private files, locks, or payload sidecars.
- Hardcoding natural-language phrases as control commands.
- Trusting an old snapshot as current fact without verification.
- Starting with a large autonomy system before a small continuation loop works.

Continuity comes from a clear field, disciplined memory, traceable archives, and a small next step that survives the session boundary.
