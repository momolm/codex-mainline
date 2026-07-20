const SUSPENDING_ITEM_TYPES = new Set([
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageGeneration",
  "webSearch",
  "contextCompaction",
]);

function turnIdFromMessage(message) {
  return message?.params?.turnId
    ?? message?.params?.turn?.id
    ?? null;
}

function itemKey(item) {
  return String(item?.id ?? `${item?.type || "item"}:single`);
}

function isModelProgressItem(item) {
  return Boolean(item?.type && item.type !== "userMessage");
}

export class TurnInactivityGuard {
  constructor({ timeoutMs = 180_000 } = {}) {
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 180_000);
    this.turnId = null;
    this.lastProgressAtMs = null;
    this.lastProgressKind = null;
    this.suspendingItems = new Map();
    this.recoveryAttemptedTurnIds = new Set();
  }

  noteTurnStarted(turnId) {
    const value = String(turnId || "").trim();
    if (!value || this.turnId === value) return;
    this.turnId = value;
    this.lastProgressAtMs = null;
    this.lastProgressKind = null;
    this.suspendingItems.clear();
  }

  noteTurnCompleted(turnId) {
    if (turnId && this.turnId && String(turnId) !== this.turnId) return;
    this.turnId = null;
    this.lastProgressAtMs = null;
    this.lastProgressKind = null;
    this.suspendingItems.clear();
  }

  noteProgress(kind, nowMs) {
    this.lastProgressAtMs = Number(nowMs);
    this.lastProgressKind = String(kind || "model_event");
  }

  noteNotification(message, nowMs = Date.now()) {
    const method = String(message?.method || "");
    if (method === "turn/started") {
      this.noteTurnStarted(turnIdFromMessage(message));
      return;
    }
    if (method === "turn/completed") {
      this.noteTurnCompleted(turnIdFromMessage(message));
      return;
    }

    const turnId = turnIdFromMessage(message);
    if (!turnId || !this.turnId || String(turnId) !== this.turnId) return;

    const item = message?.params?.item ?? null;
    if (method === "item/started" && isModelProgressItem(item)) {
      this.noteProgress(`${item.type}:started`, nowMs);
      if (SUSPENDING_ITEM_TYPES.has(item.type)) {
        this.suspendingItems.set(itemKey(item), item.type);
      }
      return;
    }

    if ((method === "item/completed" || method === "item/failed") && isModelProgressItem(item)) {
      this.suspendingItems.delete(itemKey(item));
      this.noteProgress(`${item.type}:${method === "item/failed" ? "failed" : "completed"}`, nowMs);
      return;
    }

    if (method.startsWith("item/") && (method.endsWith("/delta") || method.endsWith("/outputDelta"))) {
      this.noteProgress(method, nowMs);
    }
  }

  candidate({ turnId, nowMs = Date.now() } = {}) {
    const value = String(turnId || "").trim();
    if (!value || value !== this.turnId) return null;
    if (this.recoveryAttemptedTurnIds.has(value)) return null;
    if (this.lastProgressAtMs === null || this.suspendingItems.size > 0) return null;
    const quietMs = Number(nowMs) - this.lastProgressAtMs;
    if (quietMs < this.timeoutMs) return null;
    return {
      turnId: value,
      quietMs,
      lastProgressAtMs: this.lastProgressAtMs,
      lastProgressKind: this.lastProgressKind,
    };
  }

  markRecoveryAttempted(turnId) {
    const value = String(turnId || "").trim();
    if (!value) return;
    this.recoveryAttemptedTurnIds.add(value);
    if (this.recoveryAttemptedTurnIds.size > 64) {
      const oldest = this.recoveryAttemptedTurnIds.values().next().value;
      this.recoveryAttemptedTurnIds.delete(oldest);
    }
  }
}
