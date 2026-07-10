export const EFFORT_SHIFT_ACTION = "set_effort_and_continue";
export const EFFORT_SHIFT_SCHEMA_VERSION = 1;

function requiredText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function evaluateEffortShiftRequest({ request, state, isEffortSupported }) {
  if (!request || typeof request !== "object") {
    return { decision: "reject", reason: "invalid_request" };
  }
  if (request.schema_version !== EFFORT_SHIFT_SCHEMA_VERSION) {
    return { decision: "reject", reason: "unsupported_schema" };
  }
  if (request.action !== EFFORT_SHIFT_ACTION) {
    return { decision: "reject", reason: "unsupported_action" };
  }

  const requestId = requiredText(request.request_id);
  const threadId = requiredText(request.thread_id);
  const originTurnId = requiredText(request.origin_turn_id);
  const effort = requiredText(request.effort).toLowerCase();
  if (!requestId || !threadId || !originTurnId || !effort) {
    return { decision: "reject", reason: "missing_required_field" };
  }

  const currentThreadId = requiredText(state?.thread_id);
  if (!currentThreadId || threadId !== currentThreadId) {
    return { decision: "reject", reason: "thread_mismatch" };
  }

  const activeTurnId = requiredText(state?.active_turn_id);
  if (activeTurnId) {
    return activeTurnId === originTurnId
      ? { decision: "wait", reason: "origin_turn_active" }
      : { decision: "reject", reason: "active_turn_mismatch" };
  }

  if (requiredText(state?.last_turn_id) !== originTurnId) {
    return { decision: "reject", reason: "origin_turn_not_last" };
  }
  if (requiredText(state?.last_turn_status).toLowerCase() !== "completed") {
    return { decision: "reject", reason: "origin_turn_not_completed" };
  }
  if (typeof isEffortSupported !== "function" || !isEffortSupported(effort)) {
    return { decision: "reject", reason: "unsupported_effort" };
  }

  return {
    decision: "apply",
    reason: "ready",
    effort,
    requestId,
    threadId,
    originTurnId,
  };
}
