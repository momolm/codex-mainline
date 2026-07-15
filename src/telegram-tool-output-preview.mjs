export const DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS = 260;

function defaultOmissionMarker(chars) {
  return `[... ${chars} chars omitted ...]`;
}

function normalizeToolOutput(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function tailWindow(value, maxChars) {
  if (value.length <= maxChars) return value;
  const hardStart = Math.max(0, value.length - Math.max(1, maxChars));
  const newlineAt = value.indexOf("\n", hardStart);
  const start = newlineAt >= 0 && newlineAt < value.length - 1 ? newlineAt + 1 : hardStart;
  return value.slice(start).trimStart();
}

export function toolOutputLiveHeadChars(maxChars = DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS) {
  return Math.max(1, Math.floor(Math.trunc(Number(maxChars)) / 2));
}

function formatHeadTail({ headSource, tailSource, totalChars, maxChars, omissionMarker }) {
  const widestMarker = omissionMarker(Math.max(0, totalChars));
  const headBudget = toolOutputLiveHeadChars(maxChars);
  let head = headSource.slice(0, headBudget);
  const tailBudget = Math.max(1, maxChars - head.length - widestMarker.length - 2);
  let tail = tailWindow(tailSource, tailBudget);
  let omittedChars = Math.max(0, totalChars - head.length - tail.length);
  let marker = omissionMarker(omittedChars);
  let preview = `${head}\n${marker}\n${tail}`;

  if (preview.length > maxChars) {
    const overflow = preview.length - maxChars;
    if (tail.length >= head.length) {
      tail = tail.slice(Math.min(overflow, tail.length));
    } else {
      head = head.slice(0, Math.max(0, head.length - overflow));
    }
    omittedChars = Math.max(0, totalChars - head.length - tail.length);
    marker = omissionMarker(omittedChars);
    preview = `${head}\n${marker}\n${tail}`;
  }

  return {
    preview,
    totalChars,
    omittedChars,
    truncated: omittedChars > 0,
  };
}

export function formatToolOutputPreview(
  value,
  maxChars = DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
  { omissionMarker = defaultOmissionMarker } = {},
) {
  const limit = Math.trunc(Number(maxChars));
  if (!Number.isFinite(limit) || limit < 1) {
    throw new TypeError("maxChars must be a positive finite number");
  }
  const text = normalizeToolOutput(value);
  if (text.length <= limit) {
    return {
      preview: text,
      totalChars: text.length,
      omittedChars: 0,
      truncated: false,
    };
  }
  return formatHeadTail({
    headSource: text,
    tailSource: text,
    totalChars: text.length,
    maxChars: limit,
    omissionMarker,
  });
}

export function createToolOutputCapture() {
  return {
    totalChars: 0,
    full: "",
    head: "",
    tail: "",
    overflowed: false,
  };
}

export function capturedToolOutputLiveHead(
  capture,
  maxChars = DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
) {
  const current = capture ?? createToolOutputCapture();
  const source = normalizeToolOutput(current.overflowed ? current.head : current.full);
  return source.slice(0, toolOutputLiveHeadChars(maxChars));
}

export function captureToolOutput(
  capture,
  delta,
  edgeChars = DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
) {
  const value = String(delta ?? "");
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return capture ?? createToolOutputCapture();
  const edgeLimit = Math.max(1, Math.trunc(Number(edgeChars)) || DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS);
  const current = capture ?? createToolOutputCapture();
  const totalChars = current.totalChars + normalized.length;

  if (!current.overflowed) {
    const combined = `${current.full}${normalized}`;
    if (combined.length <= edgeLimit * 2) {
      return {
        ...current,
        totalChars,
        full: combined,
      };
    }
    return {
      totalChars,
      full: "",
      head: combined.slice(0, edgeLimit),
      tail: combined.slice(-edgeLimit),
      overflowed: true,
    };
  }

  return {
    ...current,
    totalChars,
    tail: `${current.tail}${normalized}`.slice(-edgeLimit),
  };
}

export function formatCapturedToolOutputPreview(
  capture,
  maxChars = DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
  { omissionMarker = defaultOmissionMarker } = {},
) {
  const current = capture ?? createToolOutputCapture();
  if (!current.overflowed) {
    return formatToolOutputPreview(current.full, maxChars, { omissionMarker });
  }
  return formatHeadTail({
    headSource: normalizeToolOutput(current.head),
    tailSource: normalizeToolOutput(current.tail),
    totalChars: current.totalChars,
    maxChars: Math.trunc(Number(maxChars)),
    omissionMarker,
  });
}
