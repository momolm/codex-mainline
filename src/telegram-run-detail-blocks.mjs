export const TELEGRAM_SAFE_MESSAGE_CHARS = 4000;

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function defaultTitle({ index, total, state }) {
  const suffix = total > 1 ? ` block ${index + 1}` : "";
  return `Codex run details${suffix} (${state})`;
}

function blockState(index, total, done) {
  if (index < total - 1) return "continued";
  return done ? "done" : "live";
}

function blockBody(chunk, summary) {
  const detail = String(chunk ?? "");
  const currentSummary = String(summary ?? "").trimEnd();
  return currentSummary ? `${currentSummary}\n\n---\n\n${detail}` : detail;
}

export function formatRunDetailBlock(
  chunk,
  index,
  total,
  {
    done = false,
    summary = "",
    title = defaultTitle,
  } = {},
) {
  const state = blockState(index, total, done);
  const heading = title({ index, total, state });
  return [
    `<b>${htmlEscape(heading)}</b>`,
    `<blockquote expandable>${htmlEscape(blockBody(chunk, summary))}</blockquote>`,
  ].join("\n");
}

function formattedLength(chunk, index, summaryReserve, title) {
  return formatRunDetailBlock(chunk, index, index + 2, {
    summary: summaryReserve,
    title,
  }).length;
}

function longestFittingPrefix(value, index, maxChars, summaryReserve, title) {
  let low = 1;
  let high = value.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(0, middle).trimEnd();
    if (formattedLength(candidate, index, summaryReserve, title) <= maxChars) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function splitRunDetailText(
  value,
  maxChars = TELEGRAM_SAFE_MESSAGE_CHARS,
  {
    summaryReserve = "",
    title = defaultTitle,
  } = {},
) {
  const limit = Math.trunc(Number(maxChars));
  if (!Number.isFinite(limit) || limit < 1) {
    throw new TypeError("maxChars must be a positive finite number");
  }

  const chunks = [];
  let remaining = String(value ?? "").trimEnd();
  if (!remaining) return ["(empty)"];

  while (remaining) {
    const index = chunks.length;
    if (formattedLength(remaining, index, summaryReserve, title) <= limit) {
      chunks.push(remaining);
      break;
    }

    const hardSplitAt = longestFittingPrefix(remaining, index, limit, summaryReserve, title);
    if (hardSplitAt < 1) {
      throw new RangeError(`maxChars=${limit} cannot fit a run-detail block wrapper`);
    }
    const newlineAt = remaining.lastIndexOf("\n", hardSplitAt);
    const splitAt = newlineAt > 0 ? newlineAt : hardSplitAt;
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (!chunk) {
      throw new RangeError(`maxChars=${limit} cannot fit run-detail content`);
    }
    chunks.push(chunk);
    remaining = remaining.slice(splitAt).replace(/^\n+/, "").trimEnd();
  }

  return chunks;
}

export function renderRunDetailBlocks(
  value,
  {
    maxChars = TELEGRAM_SAFE_MESSAGE_CHARS,
    done = false,
    summary = "",
    summaryReserve = summary,
    title = defaultTitle,
  } = {},
) {
  const chunks = splitRunDetailText(value, maxChars, { summaryReserve, title });
  const rendered = chunks.map((chunk, index) => (
    formatRunDetailBlock(chunk, index, chunks.length, {
      done,
      summary: index === chunks.length - 1 ? summary : "",
      title,
    })
  ));
  if (rendered.some((block) => block.length > maxChars)) {
    throw new RangeError(`rendered run-detail block exceeded maxChars=${maxChars}`);
  }
  return rendered;
}
