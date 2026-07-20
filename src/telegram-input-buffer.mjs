function collectSeconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
export function bufferTelegramInput({
  pendingInputs,
  key,
  message,
  hasImage = false,
  now = Date.now(),
  inputCollectSeconds = 1,
  imageCollectSeconds = 3,
}) {
  const existing = pendingInputs.get(key) ?? {
    key,
    messages: new Map(),
    firstSeenAt: now,
    flushAt: now,
    imageMessageCount: 0,
  };
  const messageKey = String(message?.message_id ?? `${now}:${existing.messages.size}`);
  if (!existing.messages.has(messageKey) && hasImage) {
    existing.imageMessageCount += 1;
  }
  existing.messages.set(messageKey, message);
  const delaySeconds = existing.imageMessageCount > 0
    ? collectSeconds(imageCollectSeconds, 3)
    : collectSeconds(inputCollectSeconds, 1);
  existing.flushAt = now + delaySeconds * 1000;
  existing.updatedAt = now;
  pendingInputs.set(key, existing);
  return existing;
}
