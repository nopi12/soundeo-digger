/**
 * Queue skip/listen/download signals and look up community ratings.
 * Loaded via importScripts from background.js after listen-sync.js.
 */
const SYNC_SIGNAL_QUEUE_KEY = "diggerSignalQueue";
const RATING_TTL_MS = 3 * 60 * 1000;

const ratingCache = new Map();
let signalFlushTimer = null;
let signalInFlight = false;

function invalidateRatingCache(keys) {
  if (!Array.isArray(keys) || !keys.length) {
    ratingCache.clear();
    return;
  }
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (key) ratingCache.delete(key);
  }
}

function rememberRating(key, rating) {
  if (!key || !rating) return;
  ratingCache.set(String(key), { rating: rating, fetchedAt: Date.now() });
}

function cacheRatingAliases(rating) {
  if (!rating || !Array.isArray(rating.keys)) return;
  for (let i = 0; i < rating.keys.length; i++) {
    rememberRating(rating.keys[i], rating);
  }
}

async function getSignalQueue() {
  const data = await chrome.storage.local.get([SYNC_SIGNAL_QUEUE_KEY]);
  const q = data[SYNC_SIGNAL_QUEUE_KEY];
  return Array.isArray(q) ? q : [];
}

async function setSignalQueue(queue) {
  await chrome.storage.local.set({ [SYNC_SIGNAL_QUEUE_KEY]: queue || [] });
}

function normalizeSignalPayload(signal) {
  if (!signal || typeof signal !== "object") return null;
  const kind = String(signal.kind || "").trim().toLowerCase();
  if (
    kind !== "listen_time" &&
    kind !== "listen" &&
    kind !== "skip" &&
    kind !== "download" &&
    kind !== "undownload"
  ) {
    return null;
  }
  const play = normalizePlayPayload(signal.play || signal);
  if (!play) return null;
  play.kind = kind;
  if (signal.elapsedSec != null) {
    play.elapsedSec = Number(signal.elapsedSec);
  }
  if (signal.durationSec != null) {
    play.durationSec = Number(signal.durationSec);
  }
  if (signal.listenPoints != null) {
    play.listenPoints = Number(signal.listenPoints);
  }
  return play;
}

function scheduleSignalFlush() {
  clearTimeout(signalFlushTimer);
  signalFlushTimer = setTimeout(function () {
    flushSignalQueue().catch(function () {});
  }, 400);
}

async function enqueueSignal(signal) {
  const normalized = normalizeSignalPayload(signal);
  if (!normalized) return null;
  const localKey = localKeyFromPlay(normalized);
  if (localKey) invalidateRatingCache([localKey]);
  const queue = await getSignalQueue();
  queue.push(normalized);
  if (queue.length > 500) queue.splice(0, queue.length - 500);
  await setSignalQueue(queue);
  scheduleSignalFlush();
  return { localKey: localKey, signal: normalized };
}

async function flushSignalQueue() {
  if (signalInFlight) {
    scheduleSignalFlush();
    return;
  }
  const queue = await getSignalQueue();
  if (!queue.length) return;
  signalInFlight = true;
  try {
    const creds = await ensureSyncAccount();
    const batch = queue.slice(0, 100);
    const data = await apiFetch("/v1/signals", {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.apiKey },
      body: JSON.stringify({ signals: batch })
    });
    const remaining = (await getSignalQueue()).slice(batch.length);
    await setSignalQueue(remaining);
    const keys = (data && data.keys) || [];
    invalidateRatingCache(keys);
    await setSyncStatus({
      ok: true,
      lastError: "",
      lastSignalPushAt: syncNowMs(),
      lastSignalPushCount: batch.length
    });
    if (remaining.length) scheduleSignalFlush();
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    if (typeof reportSyncError === "function") {
      reportSyncError(err, "sync:signal-flush").catch(function () {});
    }
  } finally {
    signalInFlight = false;
  }
}

async function lookupRatings(keys) {
  const wanted = [];
  const seen = {};
  if (Array.isArray(keys)) {
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i] || "");
      if (!key || seen[key]) continue;
      seen[key] = true;
      wanted.push(key);
    }
  }
  const now = Date.now();
  const result = {};
  const missing = [];
  for (let i = 0; i < wanted.length; i++) {
    const key = wanted[i];
    const hit = ratingCache.get(key);
    if (hit && hit.rating && now - hit.fetchedAt < RATING_TTL_MS) {
      result[key] = hit.rating;
    } else {
      missing.push(key);
    }
  }
  if (!missing.length) return { ok: true, ratings: result, count: Object.keys(result).length };

  try {
    const creds = await ensureSyncAccount();
    const data = await apiFetch("/v1/ratings/lookup", {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.apiKey },
      body: JSON.stringify({ keys: missing.slice(0, 120) })
    });
    const ratings = (data && data.ratings) || {};
    const foundKeys = Object.keys(ratings);
    for (let i = 0; i < foundKeys.length; i++) {
      const key = foundKeys[i];
      const rating = ratings[key];
      rememberRating(key, rating);
      cacheRatingAliases(rating);
      result[key] = rating;
    }
    await setSyncStatus({ ok: true, lastError: "" });
    return { ok: true, ratings: result, count: Object.keys(result).length };
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    if (typeof reportSyncError === "function") {
      reportSyncError(err, "sync:rating-lookup").catch(function () {});
    }
    return { ok: false, ratings: result, error: String(err.message || err) };
  }
}

function initRatingSync() {
  flushSignalQueue().catch(function () {});
}
