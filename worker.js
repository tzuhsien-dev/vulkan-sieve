"use strict";

let cancelled = false;

const BATCH_SIZE = 1200;
const PROGRESS_INTERVAL_MS = 120;
const BIND_COMMAND_RE = /\bvkCmdBind[A-Za-z0-9_]*\b/;
const SET_COMMAND_RE = /\bvkCmdSet[A-Za-z0-9_]*\b/;
const FRAME_RE = /\[F#(\d+)\]/;
const API_CALL_RE = /\b(vk[A-Za-z0-9_]+)(?=\s*(?:\(|:))/;
const ANDROID_LOG_PREFIX_RE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+(\d+)\s+(\d+)\s+\S\s+/;

self.onmessage = event => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled = true;
    return;
  }

  if (message.type === "start") {
    cancelled = false;
    scanFile(message.file, message.filters).catch(error => {
      self.postMessage({
        type: "error",
        error: error && error.message ? error.message : String(error)
      });
    });
  }
};

async function scanFile(file, filters) {
  if (!file || typeof file.stream !== "function") {
    throw new Error("This browser does not support File.stream().");
  }
  if (typeof TextDecoderStream === "undefined") {
    throw new Error("This browser does not support TextDecoderStream in Web Workers.");
  }

  const normalized = normalizeFilters(filters);
  const stats = { read: 0, matched: 0, skipped: 0 };
  const frames = new Set();
  const tids = new Set();
  const batch = [];
  let lineNumber = 0;
  let carry = "";
  let approxBytesRead = 0;
  let lastProgressAt = performance.now();

  const reader = file
    .stream()
    .pipeThrough(new TextDecoderStream())
    .getReader();

  try {
    while (!cancelled) {
      const { value, done } = await reader.read();
      if (done) break;

      approxBytesRead += value.length;
      const text = carry + value;
      const lines = text.split(/\r?\n/);
      carry = lines.pop() || "";

      for (const line of lines) {
        if (cancelled) break;
        lineNumber += 1;
        processLine(line, lineNumber, normalized, stats, batch, frames, tids);
        if (batch.length >= BATCH_SIZE) {
          flushBatch(batch, stats);
        }
      }

      const now = performance.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        postProgress(stats, approxBytesRead);
        lastProgressAt = now;
      }
    }

    if (!cancelled && carry.length > 0) {
      lineNumber += 1;
      processLine(carry, lineNumber, normalized, stats, batch, frames, tids);
    }

    flushBatch(batch, stats);
    postProgress(stats, file.size || approxBytesRead);
    self.postMessage({
      type: "done",
      stats,
      frames: Array.from(frames).sort((a, b) => a - b),
      tids: Array.from(tids).sort((a, b) => a - b),
      wasCancelled: cancelled
    });
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      // Reader may already be closed.
    }
  }
}

function normalizeFilters(filters) {
  const keyword = (filters && filters.keyword ? String(filters.keyword) : "").trim();
  const focusHandle = (filters && filters.focusHandle ? String(filters.focusHandle) : "").trim();
  return {
    keyword,
    keywordLower: keyword.toLowerCase(),
    focusHandle,
    focusHandleLower: focusHandle.toLowerCase(),
    focusOnly: Boolean(filters && filters.focusOnly),
    hideBind: Boolean(filters && filters.hideBind),
    hideSet: Boolean(filters && filters.hideSet)
  };
}

function processLine(line, lineNumber, filters, stats, batch, frames, tids) {
  stats.read += 1;
  const frameNumber = getFrameNumber(line);
  const thread = getThreadInfo(line);
  if (frameNumber !== null) {
    frames.add(frameNumber);
  }
  if (thread.tid !== null) {
    tids.add(thread.tid);
  }

  if (filters.hideBind && BIND_COMMAND_RE.test(line)) {
    stats.skipped += 1;
    return;
  }

  if (filters.hideSet && SET_COMMAND_RE.test(line)) {
    stats.skipped += 1;
    return;
  }

  const lower = (filters.keywordLower || filters.focusHandleLower)
    ? line.toLowerCase()
    : "";

  if (filters.keywordLower && !lower.includes(filters.keywordLower)) {
    stats.skipped += 1;
    return;
  }

  if (filters.focusOnly && filters.focusHandleLower && !lower.includes(filters.focusHandleLower)) {
    stats.skipped += 1;
    return;
  }

  stats.matched += 1;
  batch.push({
    lineNumber,
    text: line,
    frameNumber,
    pid: thread.pid,
    tid: thread.tid,
    apiName: getApiName(line)
  });
}

function getFrameNumber(line) {
  const match = FRAME_RE.exec(line);
  return match ? Number(match[1]) : null;
}

function getApiName(line) {
  const match = API_CALL_RE.exec(line);
  return match ? match[1] : null;
}

function getThreadInfo(line) {
  const match = ANDROID_LOG_PREFIX_RE.exec(line);
  return match
    ? { pid: Number(match[1]), tid: Number(match[2]) }
    : { pid: null, tid: null };
}

function flushBatch(batch, stats) {
  if (batch.length === 0) return;
  self.postMessage({
    type: "batch",
    items: batch.splice(0, batch.length),
    stats: { ...stats }
  });
}

function postProgress(stats, approxBytesRead) {
  self.postMessage({
    type: "progress",
    approxBytesRead,
    stats: { ...stats }
  });
}
