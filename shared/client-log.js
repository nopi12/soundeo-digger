/**
 * Client error/warn logging → digger-api.
 * Loaded via importScripts after listen-sync.js (uses its helpers).
 */
const CLIENT_LOG_QUEUE_KEY = "diggerClientLogQueue";

function getClientLogExtVersion() {
  if (typeof getExtVersion === "function") return getExtVersion();
  try {
    return chrome.runtime.getManifest().version || "0";
  } catch (_) {
    return "0";
  }
}

let clientLogFlushTimer = null;
let clientLogInFlight = false;
let clientLogMuteUntil = 0;

function clientLogNowSec() {
  return Date.now() / 1000;
}

function normalizeClientLog(entry) {
  if (!entry || typeof entry !== "object") return null;
  const message = String(entry.message || entry.error || "").trim().slice(0, 1000);
  if (!message) return null;
  let level = String(entry.level || "error").toLowerCase();
  if (level !== "error" && level !== "warn" && level !== "info" && level !== "debug") {
    level = "error";
  }
  let context = entry.context;
  if (context != null && typeof context !== "object") {
    context = { value: String(context).slice(0, 500) };
  }
  if (context && typeof context === "object") {
    try {
      const raw = JSON.stringify(context);
      if (raw.length > 3500) context = { truncated: raw.slice(0, 3500) };
    } catch (_) {
      context = { note: "unserializable" };
    }
  }
  return {
    level: level,
    message: message,
    source: String(entry.source || "extension").slice(0, 64),
    platform: String(entry.platform || "").slice(0, 32),
    extVersion: String(entry.extVersion || getClientLogExtVersion()).slice(0, 32),
    stack: String(entry.stack || "").slice(0, 4000),
    url: String(entry.url || "").slice(0, 500),
    ts: Number(entry.ts) || clientLogNowSec(),
    context: context || null
  };
}

async function getClientLogQueue() {
  const data = await chrome.storage.local.get([CLIENT_LOG_QUEUE_KEY]);
  const q = data[CLIENT_LOG_QUEUE_KEY];
  return Array.isArray(q) ? q : [];
}

async function setClientLogQueue(queue) {
  await chrome.storage.local.set({ [CLIENT_LOG_QUEUE_KEY]: queue || [] });
}

function scheduleClientLogFlush(delayMs) {
  clearTimeout(clientLogFlushTimer);
  clientLogFlushTimer = setTimeout(function () {
    flushClientLogQueue().catch(function () {});
  }, delayMs == null ? 1200 : delayMs);
}

async function enqueueClientLog(entry) {
  const normalized = normalizeClientLog(entry);
  if (!normalized) return false;
  // Dedupe identical errors within the queue
  const queue = await getClientLogQueue();
  const fingerprint =
    normalized.level + "|" + normalized.source + "|" + normalized.message;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (
      item &&
      item.level + "|" + item.source + "|" + item.message === fingerprint
    ) {
      item.ts = normalized.ts;
      item.context = normalized.context;
      await setClientLogQueue(queue);
      scheduleClientLogFlush(normalized.level === "error" ? 400 : 1500);
      return true;
    }
  }
  queue.push(normalized);
  if (queue.length > 80) queue.splice(0, queue.length - 80);
  await setClientLogQueue(queue);
  scheduleClientLogFlush(normalized.level === "error" ? 400 : 1500);
  return true;
}

async function flushClientLogQueue() {
  if (clientLogInFlight) {
    scheduleClientLogFlush(2000);
    return;
  }
  if (Date.now() < clientLogMuteUntil) return;
  const queue = await getClientLogQueue();
  if (!queue.length) return;
  clientLogInFlight = true;
  try {
    const creds = await ensureSyncAccount();
    const batch = queue.slice(0, 40);
    await apiFetch("/v1/logs", {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.apiKey },
      body: JSON.stringify({ logs: batch })
    });
    const remaining = (await getClientLogQueue()).slice(batch.length);
    await setClientLogQueue(remaining);
    if (remaining.length) scheduleClientLogFlush(1500);
  } catch (_) {
    // Avoid log-storm if API is down
    clientLogMuteUntil = Date.now() + 60 * 1000;
  } finally {
    clientLogInFlight = false;
  }
}

function reportClientLog(level, message, extras) {
  const extra = extras || {};
  return enqueueClientLog({
    level: level,
    message: message,
    source: extra.source || "background",
    platform: extra.platform || "",
    stack: extra.stack || "",
    url: extra.url || "",
    context: extra.context || null,
    extVersion: extra.extVersion || getClientLogExtVersion(),
    ts: clientLogNowSec()
  });
}

function reportClientError(message, extras) {
  return reportClientLog("error", message, extras);
}

function reportClientWarn(message, extras) {
  return reportClientLog("warn", message, extras);
}

function reportSyncError(err, source) {
  const message = String((err && err.message) || err || "sync error");
  return reportClientError(message, {
    source: source || "sync",
    context: {
      status: err && err.status != null ? err.status : null
    }
  });
}

function initClientLogging() {
  try {
    self.addEventListener("error", function (event) {
      reportClientError(String((event && event.message) || "background error"), {
        source: "background:error",
        stack: event && event.error && event.error.stack ? String(event.error.stack) : "",
        context: {
          filename: event && event.filename ? String(event.filename) : "",
          lineno: event && event.lineno != null ? event.lineno : null
        }
      }).catch(function () {});
    });
  } catch (_) {}
  try {
    self.addEventListener("unhandledrejection", function (event) {
      const reason = event && event.reason;
      const message =
        reason && reason.message
          ? String(reason.message)
          : String(reason || "unhandledrejection");
      reportClientError(message, {
        source: "background:unhandledrejection",
        stack: reason && reason.stack ? String(reason.stack) : ""
      }).catch(function () {});
    });
  } catch (_) {}
  scheduleClientLogFlush(3000);
}
