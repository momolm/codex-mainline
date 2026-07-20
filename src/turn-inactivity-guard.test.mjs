import assert from "node:assert/strict";
import test from "node:test";

import { TurnInactivityGuard } from "./turn-inactivity-guard.mjs";

function event(method, turnId, item = null) {
  return { method, params: { turnId, ...(item ? { item } : {}) } };
}

test("initial model wait is never treated as a stalled stream", () => {
  const guard = new TurnInactivityGuard({ timeoutMs: 1_000 });
  guard.noteTurnStarted("turn-1");
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 10_000 }), null);
});

test("completed reasoning arms recovery after the quiet threshold", () => {
  const guard = new TurnInactivityGuard({ timeoutMs: 1_000 });
  guard.noteTurnStarted("turn-1");
  guard.noteNotification(event("item/started", "turn-1", { id: "r1", type: "reasoning" }), 100);
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 5_000 }), null);
  guard.noteNotification(event("item/completed", "turn-1", { id: "r1", type: "reasoning" }), 500);
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 1_499 }), null);
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 1_500 })?.lastProgressKind, "reasoning:completed");
});

test("parallel tools suppress recovery until every tool completes", () => {
  const guard = new TurnInactivityGuard({ timeoutMs: 1_000 });
  guard.noteTurnStarted("turn-1");
  guard.noteNotification(event("item/started", "turn-1", { id: "a", type: "commandExecution" }), 100);
  guard.noteNotification(event("item/started", "turn-1", { id: "b", type: "commandExecution" }), 200);
  guard.noteNotification(event("item/completed", "turn-1", { id: "a", type: "commandExecution" }), 300);
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 5_000 }), null);
  guard.noteNotification(event("item/completed", "turn-1", { id: "b", type: "commandExecution" }), 500);
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 1_500 })?.turnId, "turn-1");
});

test("non-model notifications neither arm nor refresh the guard", () => {
  const guard = new TurnInactivityGuard({ timeoutMs: 1_000 });
  guard.noteTurnStarted("turn-1");
  guard.noteNotification(event("item/completed", "turn-1", { id: "r1", type: "reasoning" }), 100);
  guard.noteNotification({ method: "thread/tokenUsage/updated", params: { turnId: "turn-1" } }, 900);
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 1_100 })?.quietMs, 1_000);
});

test("one turn can request recovery only once", () => {
  const guard = new TurnInactivityGuard({ timeoutMs: 1_000 });
  guard.noteTurnStarted("turn-1");
  guard.noteNotification(event("item/completed", "turn-1", { id: "r1", type: "reasoning" }), 100);
  assert.ok(guard.candidate({ turnId: "turn-1", nowMs: 1_100 }));
  guard.markRecoveryAttempted("turn-1");
  assert.equal(guard.candidate({ turnId: "turn-1", nowMs: 5_000 }), null);
  guard.noteTurnCompleted("turn-1");
  guard.noteTurnStarted("turn-2");
  guard.noteNotification(event("item/completed", "turn-2", { id: "r2", type: "reasoning" }), 6_000);
  assert.ok(guard.candidate({ turnId: "turn-2", nowMs: 7_000 }));
});
