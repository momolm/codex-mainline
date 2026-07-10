import assert from "node:assert/strict";
import test from "node:test";

import {
  EFFORT_SHIFT_ACTION,
  EFFORT_SHIFT_SCHEMA_VERSION,
  evaluateEffortShiftRequest,
} from "./effort-shift-request.mjs";

function request(overrides = {}) {
  return {
    schema_version: EFFORT_SHIFT_SCHEMA_VERSION,
    request_id: "request-1",
    action: EFFORT_SHIFT_ACTION,
    effort: "max",
    thread_id: "thread-1",
    origin_turn_id: "turn-1",
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    thread_id: "thread-1",
    active_turn_id: null,
    last_turn_id: "turn-1",
    last_turn_status: "completed",
    ...overrides,
  };
}

const supports = (effort) => ["high", "xhigh", "max"].includes(effort);

test("waits while the origin turn is active", () => {
  assert.deepEqual(
    evaluateEffortShiftRequest({
      request: request(),
      state: state({ active_turn_id: "turn-1" }),
      isEffortSupported: supports,
    }),
    { decision: "wait", reason: "origin_turn_active" },
  );
});

test("applies after the bound origin turn completes", () => {
  assert.equal(
    evaluateEffortShiftRequest({ request: request(), state: state(), isEffortSupported: supports }).decision,
    "apply",
  );
});

test("rejects interrupted origin turns", () => {
  assert.deepEqual(
    evaluateEffortShiftRequest({
      request: request(),
      state: state({ last_turn_status: "interrupted" }),
      isEffortSupported: supports,
    }),
    { decision: "reject", reason: "origin_turn_not_completed" },
  );
});

test("rejects a request bound to another thread", () => {
  assert.deepEqual(
    evaluateEffortShiftRequest({
      request: request({ thread_id: "thread-2" }),
      state: state(),
      isEffortSupported: supports,
    }),
    { decision: "reject", reason: "thread_mismatch" },
  );
});

test("rejects a request when another turn became active", () => {
  assert.deepEqual(
    evaluateEffortShiftRequest({
      request: request(),
      state: state({ active_turn_id: "turn-2" }),
      isEffortSupported: supports,
    }),
    { decision: "reject", reason: "active_turn_mismatch" },
  );
});

test("validates effort through the supplied live-catalog predicate", () => {
  assert.deepEqual(
    evaluateEffortShiftRequest({
      request: request({ effort: "future" }),
      state: state(),
      isEffortSupported: supports,
    }),
    { decision: "reject", reason: "unsupported_effort" },
  );
});
