export async function deliverAssistantText({
  text,
  richMarkdown = false,
  sendRich,
  sendPlain,
  onRichFallback = () => {},
}) {
  const value = String(text || "");
  if (richMarkdown && value.trim()) {
    try {
      return await sendRich(value);
    } catch (error) {
      await onRichFallback(error);
    }
  }
  return await sendPlain(value);
}
