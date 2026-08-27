/**
 * Cloud sync for listened tracks (service worker helper).
 * Loaded via importScripts from background.js.
 */
const DIGGER_API_BASE =
  "https://fervent-panini.93-90-203-17.plesk.page/digger-api";
const SYNC_USER_KEY = "diggerUserId";
const SYNC_API_KEY = "diggerApiKey";
const SYNC_QUEUE_KEY = "diggerPlayQueue";
const SYNC_WANT_QUEUE_KEY = "diggerWantQueue";
const SYNC_STATUS_KEY = "diggerSyncStatus";
const WANT_STORAGE_KEY = "wantDownloadTracks";
const WANT_META_KEY = "wantDownloadMeta";

let syncFlushTimer = null;
let syncPullTimer = null;
let syncInFlight = false;

function syncNowMs() {
  return Date.now();
}

async function getSyncCredentials() {
  const data = await chrome.storage.sync.get([SYNC_USER_KEY, SYNC_API_KEY]);
  return {
    userId: data[SYNC_USER_KEY] || "",
    apiKey: data[SYNC_API_KEY] || ""
  };
}

async function setSyncCredentials(userId, apiKey) {
  await chrome.storage.sync.set({
    [SYNC_USER_KEY]: String(userId || ""),
    [SYNC_API_KEY]: String(apiKey || "")
  });
}

async function setSyncStatus(patch) {
  const prev = await chrome.storage.local.get([SYNC_STATUS_KEY]);
  const cur =
    prev[SYNC_STATUS_KEY] && typeof prev[SYNC_STATUS_KEY] === "object"
      ? prev[SYNC_STATUS_KEY]
      : {};
  const next = Object.assign({}, cur, patch, { updatedAt: syncNowMs() });
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: next });
  return next;
}

async function apiFetch(path, options) {
  const opts = options || {};
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    opts.headers || {}
  );
  const res = await fetch(DIGGER_API_BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body != null ? opts.body : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.detail) || "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function ensureSyncAccount() {
  const creds = await getSyncCredentials();
  if (creds.apiKey && creds.userId) return creds;
  const created = await apiFetch("/v1/register", { method: "POST", body: "{}" });
  await setSyncCredentials(created.user_id, created.api_key);
  await setSyncStatus({ ok: true, lastError: "" });
  return { userId: created.user_id, apiKey: created.api_key };
}

async function linkSyncAccount(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Sync-Key fehlt");
  const linked = await apiFetch("/v1/link", {
    method: "POST",
    body: JSON.stringify({ apiKey: key })
  });
  await setSyncCredentials(linked.user_id, linked.api_key);
  await setSyncStatus({ ok: true, lastError: "" });
  await pullRemotePlays(true);
  return linked;
}

async function getPlayQueue() {
  const data = await chrome.storage.local.get([SYNC_QUEUE_KEY]);
  const q = data[SYNC_QUEUE_KEY];
  return Array.isArray(q) ? q : [];
}

async function setPlayQueue(queue) {
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue || [] });
}

function normalizePlayPayload(play) {
  if (!play || typeof play !== "object") return null;
  const platform = String(play.platform || "").trim().toLowerCase();
  let externalId = String(play.externalId || play.external_id || "").trim();
  if (!platform || !externalId) return null;
  if (platform === "soundcloud" && externalId.startsWith("sc:")) {
    externalId = externalId.slice(3);
  }
  const durationSec = Number(play.durationSec != null ? play.durationSec : play.duration_sec);
  const bpm = Number(play.bpm);
  return {
    platform,
    externalId,
    rawTitle: String(play.rawTitle || play.raw_title || "").slice(0, 300),
    artist: String(play.artist || "").slice(0, 200),
    title: String(play.title || "").slice(0, 200),
    url: String(play.url || "").slice(0, 500),
    playedAt: Number(play.playedAt || play.played_at) || syncNowMs() / 1000,
    durationSec:
      Number.isFinite(durationSec) && durationSec > 0 && durationSec < 36000
        ? Math.round(durationSec)
        : null,
    bpm: Number.isFinite(bpm) && bpm > 40 && bpm < 400 ? Math.round(bpm * 10) / 10 : null,
    label: String(play.label || "").slice(0, 200),
    musicalKey: String(play.musicalKey || play.musical_key || "").slice(0, 32)
  };
}

function localKeyFromPlay(play) {
  if (!play) return null;
  if (play.platform === "soundcloud") {
    const id = play.externalId.startsWith("sc:")
      ? play.externalId
      : "sc:" + play.externalId;
    return id;
  }
  return play.externalId;
}

function diggerDiagLog(level, message, context) {
  try {
    if (typeof reportClientLog !== "function") return;
    reportClientLog(level, message, {
      source: "want-sync",
      context: context || null
    }).catch(function () {});
  } catch (_) {}
}

function summarizeWantPlay(play) {
  if (!play) return null;
  return {
    platform: play.platform || "",
    externalId: play.externalId || "",
    localKey: localKeyFromPlay(play),
    artist: play.artist || "",
    title: play.title || "",
    rawTitle: play.rawTitle || "",
    durationSec: play.durationSec != null ? play.durationSec : null,
    bpm: play.bpm != null ? play.bpm : null,
    label: play.label || "",
    musicalKey: play.musicalKey || ""
  };
}

function summarizeWantApiResults(data) {
  const results = (data && data.results) || [];
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    if (!row) continue;
    const pending = row.pendingMatch || null;
    out.push({
      trackId: row.trackId || "",
      keys: row.keys || [],
      pending: pending
        ? {
            status: pending.status || "",
            score: pending.score,
            candidateTrackId: pending.candidateTrackId || "",
            candidateArtist: pending.candidateArtist || "",
            candidateTitle: pending.candidateTitle || "",
            candidateKeys: pending.candidateKeys || []
          }
        : null
    });
  }
  return {
    keys: (data && data.keys) || [],
    recorded: data && data.recorded != null ? data.recorded : null,
    results: out
  };
}

async function enqueuePlay(play) {
  const normalized = normalizePlayPayload(play);
  if (!normalized) return null;
  const localKey = localKeyFromPlay(normalized);
  const played = await getPlayed();
  if (localKey && !played[localKey]) {
    played[localKey] = true;
    await setPlayed(played);
  }
  const queue = await getPlayQueue();
  const dedupe = normalized.platform + "|" + normalized.externalId;
  const filtered = queue.filter(function (item) {
    return item && item.platform + "|" + item.externalId !== dedupe;
  });
  filtered.push(normalized);
  if (filtered.length > 500) filtered.splice(0, filtered.length - 500);
  await setPlayQueue(filtered);
  scheduleSyncFlush();
  return { localKey, play: normalized };
}

async function enqueueUnmark(play) {
  const normalized = normalizePlayPayload(play);
  if (!normalized) return;
  const localKey = localKeyFromPlay(normalized);
  if (localKey) {
    const played = await getPlayed();
    if (played[localKey]) {
      delete played[localKey];
      await setPlayed(played);
    }
  }
  try {
    const creds = await ensureSyncAccount();
    await apiFetch(
      "/v1/plays/" +
        encodeURIComponent(normalized.platform) +
        "/" +
        encodeURIComponent(normalized.externalId),
      {
        method: "DELETE",
        headers: { Authorization: "Bearer " + creds.apiKey }
      }
    );
    if (localKey) {
      broadcastPlayedChanged([localKey], "remove");
    }
    await setSyncStatus({ ok: true, lastError: "" });
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    reportSyncError(err, "sync:unmark").catch(function () {});
  }
}

function scheduleSyncFlush() {
  clearTimeout(syncFlushTimer);
  syncFlushTimer = setTimeout(function () {
    flushPlayQueue().catch(function () {});
  }, 400);
}

async function mergeKeysIntoLocal(keys) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const played = await getPlayed();
  const added = [];
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (!key || played[key]) continue;
    played[key] = true;
    added.push(key);
  }
  if (added.length) {
    await setPlayed(played);
    broadcastPlayedChanged(added, "add");
  }
  return added;
}

function broadcastPlayedChanged(keys, action) {
  broadcastToAllPlatformTabs({
    type: "PLAYED_SYNC",
    action: action || "merge",
    keys: keys || []
  });
}

function broadcastMatchPrompts(results) {
  if (!Array.isArray(results) || !results.length) return;
  const prompts = [];
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    if (!row || !row.pendingMatch) continue;
    const pending = row.pendingMatch;
    prompts.push({
      trackId: pending.trackId || row.trackId,
      candidateTrackId: pending.candidateTrackId,
      score: pending.score,
      sourceArtist: pending.sourceArtist || "",
      sourceTitle: pending.sourceTitle || "",
      sourcePlatform: pending.sourcePlatform || "",
      sourceDurationSec: pending.sourceDurationSec,
      sourceBpm: pending.sourceBpm,
      sourceLabel: pending.sourceLabel || "",
      candidateArtist: pending.candidateArtist || "",
      candidateTitle: pending.candidateTitle || "",
      candidateDurationSec: pending.candidateDurationSec,
      candidateBpm: pending.candidateBpm,
      candidateLabel: pending.candidateLabel || "",
      candidateMusicalKey: pending.candidateMusicalKey || "",
      candidateKeys: pending.candidateKeys || []
    });
  }
  if (!prompts.length) return;
  broadcastToAllPlatformTabs({
    type: "MATCH_PROMPT",
    prompts: prompts
  });
}

async function confirmMatchDecision(payload) {
  const trackId = String((payload && payload.trackId) || "").trim();
  const candidateTrackId = String((payload && payload.candidateTrackId) || "").trim();
  const keepTrackId = String((payload && payload.keepTrackId) || trackId).trim();
  if (!trackId || !candidateTrackId) throw new Error("match ids missing");
  const creds = await ensureSyncAccount();
  const data = await apiFetch("/v1/match/confirm", {
    method: "POST",
    headers: { Authorization: "Bearer " + creds.apiKey },
    body: JSON.stringify({
      trackId: trackId,
      candidateTrackId: candidateTrackId,
      keepTrackId: keepTrackId
    })
  });
  if (data && Array.isArray(data.keys)) {
    await mergeKeysIntoLocal(data.keys);
    await mergeWantKeysIntoLocal(data.keys);
  }
  await setSyncStatus({ ok: true, lastError: "" });
  return data;
}

async function rejectMatchDecision(payload) {
  const trackId = String((payload && payload.trackId) || "").trim();
  const candidateTrackId = String((payload && payload.candidateTrackId) || "").trim();
  if (!trackId || !candidateTrackId) throw new Error("match ids missing");
  const creds = await ensureSyncAccount();
  await apiFetch("/v1/match/reject", {
    method: "POST",
    headers: { Authorization: "Bearer " + creds.apiKey },
    body: JSON.stringify({
      trackId: trackId,
      candidateTrackId: candidateTrackId
    })
  });
  await setSyncStatus({ ok: true, lastError: "" });
  return { ok: true };
}

async function getWantDownloads() {
  const data = await chrome.storage.local.get([WANT_STORAGE_KEY]);
  return data[WANT_STORAGE_KEY] && typeof data[WANT_STORAGE_KEY] === "object"
    ? data[WANT_STORAGE_KEY]
    : {};
}

async function setWantDownloads(obj) {
  await chrome.storage.local.set({ [WANT_STORAGE_KEY]: obj || {} });
}

async function getWantMeta() {
  const data = await chrome.storage.local.get([WANT_META_KEY]);
  return data[WANT_META_KEY] && typeof data[WANT_META_KEY] === "object"
    ? data[WANT_META_KEY]
    : {};
}

async function setWantMeta(obj) {
  await chrome.storage.local.set({ [WANT_META_KEY]: obj || {} });
}

function normalizeWantText(value) {
  let text = String(value || "")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "");
  text = text.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  text = text.replace(
    /\b(premiere|exclusive|original\s+mix|extended\s+mix|radio\s+edit|official(?:\s+audio)?)\b/g,
    " "
  );
  text = text.replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
  // light plural stem for last token
  const parts = text.split(" ");
  if (parts.length) {
    const last = parts[parts.length - 1];
    if (last.length > 4 && last.endsWith("s") && !last.endsWith("ss")) {
      parts[parts.length - 1] = last.slice(0, -1);
      text = parts.join(" ");
    }
  }
  return text;
}

function wantFingerprint(artist, title) {
  const a = normalizeWantText(artist);
  const t = normalizeWantText(title);
  if (!a || !t) return "";
  return a + "|" + t;
}

function parseWantIdentity(play) {
  if (!play) return { artist: "", title: "", fingerprint: "" };
  let artist = String(play.artist || "").trim();
  let title = String(play.title || "").trim();
  const raw = String(play.rawTitle || play.raw_title || "").trim();
  // Prefer nested "Artist - Title" inside SC premiere titles
  const blob = title || raw;
  const sep = blob.indexOf(" - ");
  if (sep > 0) {
    const left = blob.slice(0, sep).trim();
    const right = blob
      .slice(sep + 3)
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (left && right && left.split(/\s+/).length <= 5) {
      artist = left;
      title = right;
    }
  }
  if (!title && raw) title = raw;
  const fingerprint = wantFingerprint(artist, title);
  return { artist: artist, title: title, fingerprint: fingerprint };
}

async function upsertWantMeta(entry) {
  if (!entry) return null;
  const artist = String(entry.artist || "").trim();
  const title = String(entry.title || "").trim();
  const fingerprint =
    entry.fingerprint || wantFingerprint(artist, title);
  if (!fingerprint) return null;
  const meta = await getWantMeta();
  const prev = meta[fingerprint] && typeof meta[fingerprint] === "object"
    ? meta[fingerprint]
    : {};
  const keys = Array.isArray(entry.keys) ? entry.keys.slice() : [];
  const mergedKeys = Array.isArray(prev.keys) ? prev.keys.slice() : [];
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (key && mergedKeys.indexOf(key) < 0) mergedKeys.push(key);
  }
  meta[fingerprint] = {
    artist: artist || prev.artist || "",
    title: title || prev.title || "",
    artistNorm: normalizeWantText(artist || prev.artist || ""),
    titleNorm: normalizeWantText(title || prev.title || ""),
    keys: mergedKeys,
    trackId: entry.trackId || prev.trackId || "",
    updatedAt: syncNowMs()
  };
  await setWantMeta(meta);
  return meta[fingerprint];
}

async function removeWantMetaForKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  const keySet = {};
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (key) keySet[key] = true;
  }
  const meta = await getWantMeta();
  let changed = false;
  Object.keys(meta).forEach(function (fp) {
    const row = meta[fp];
    if (!row || !Array.isArray(row.keys)) return;
    const nextKeys = row.keys.filter(function (k) {
      return !keySet[k];
    });
    if (nextKeys.length !== row.keys.length) {
      changed = true;
      if (!nextKeys.length) delete meta[fp];
      else row.keys = nextKeys;
    }
  });
  if (changed) await setWantMeta(meta);
}

function broadcastWantChanged(keys, action, metaPatch) {
  broadcastToAllPlatformTabs({
    type: "WANT_SYNC",
    action: action || "merge",
    keys: keys || [],
    meta: metaPatch || null
  });
}

async function getWantQueue() {
  const data = await chrome.storage.local.get([SYNC_WANT_QUEUE_KEY]);
  const q = data[SYNC_WANT_QUEUE_KEY];
  return Array.isArray(q) ? q : [];
}

async function setWantQueue(queue) {
  await chrome.storage.local.set({ [SYNC_WANT_QUEUE_KEY]: queue || [] });
}

async function mergeWantKeysIntoLocal(keys, action, metaEntries) {
  if (action === "clear") {
    await setWantDownloads({});
    await setWantMeta({});
    broadcastWantChanged([], "clear");
    return [];
  }
  if (!Array.isArray(keys) || !keys.length) {
    if (Array.isArray(metaEntries) && metaEntries.length) {
      for (let m = 0; m < metaEntries.length; m++) {
        await upsertWantMeta(metaEntries[m]);
      }
      broadcastWantChanged([], "meta", await getWantMeta());
    }
    return [];
  }
  const wants = await getWantDownloads();
  const changed = [];
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (!key) continue;
    if (action === "remove") {
      if (wants[key]) {
        delete wants[key];
        changed.push(key);
      }
    } else if (!wants[key]) {
      wants[key] = true;
      changed.push(key);
    }
  }
  if (action === "remove") {
    await removeWantMetaForKeys(keys);
  } else if (Array.isArray(metaEntries)) {
    for (let m = 0; m < metaEntries.length; m++) {
      await upsertWantMeta(metaEntries[m]);
    }
  }
  if (changed.length) {
    await setWantDownloads(wants);
  }
  if (changed.length || (Array.isArray(metaEntries) && metaEntries.length)) {
    broadcastWantChanged(
      changed,
      action === "remove" ? "remove" : "add",
      await getWantMeta()
    );
  }
  return changed;
}

async function enqueueWantDownload(play) {
  const normalized = normalizePlayPayload(play);
  if (!normalized) {
    diggerDiagLog("warn", "want enqueue skipped: invalid payload", {
      step: "enqueue",
      raw: play || null
    });
    return null;
  }
  const localKey = localKeyFromPlay(normalized);
  const identity = parseWantIdentity(normalized);
  const wants = await getWantDownloads();
  const alreadyLocal = Boolean(localKey && wants[localKey]);
  if (localKey && !wants[localKey]) {
    wants[localKey] = true;
    await setWantDownloads(wants);
  }
  if (typeof invalidateRatingCache === "function" && localKey) {
    invalidateRatingCache([localKey]);
  }
  const metaRow = await upsertWantMeta({
    artist: identity.artist,
    title: identity.title,
    fingerprint: identity.fingerprint,
    keys: localKey ? [localKey] : []
  });
  broadcastWantChanged(
    localKey && !alreadyLocal ? [localKey] : [],
    "add",
    await getWantMeta()
  );
  const queue = await getWantQueue();
  const dedupe = normalized.platform + "|" + normalized.externalId;
  const filtered = queue.filter(function (item) {
    return item && item.platform + "|" + item.externalId !== dedupe;
  });
  filtered.push(normalized);
  if (filtered.length > 500) filtered.splice(0, filtered.length - 500);
  await setWantQueue(filtered);
  diggerDiagLog("info", "want enqueue", {
    step: "enqueue",
    alreadyLocal: alreadyLocal,
    queueLength: filtered.length,
    fingerprint: identity.fingerprint,
    play: summarizeWantPlay(normalized),
    meta: metaRow
  });
  scheduleSyncFlush();
  return { localKey, play: normalized };
}

async function enqueueUnwantDownload(play) {
  const normalized = normalizePlayPayload(play);
  if (!normalized) {
    diggerDiagLog("warn", "unwant skipped: invalid payload", { step: "unwant" });
    return;
  }
  const localKey = localKeyFromPlay(normalized);
  const dedupe = normalized.platform + "|" + normalized.externalId;

  // Drop pending uploads so a later flush cannot re-add the want.
  const queue = await getWantQueue();
  await setWantQueue(
    queue.filter(function (item) {
      return item && item.platform + "|" + item.externalId !== dedupe;
    })
  );

  const removedKeys = [];
  if (localKey) removedKeys.push(localKey);

  try {
    const creds = await ensureSyncAccount();
    const data = await apiFetch("/v1/want-downloads/remove", {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.apiKey },
      body: JSON.stringify({
        platform: normalized.platform,
        externalId: normalized.externalId,
        rawTitle: normalized.rawTitle,
        artist: normalized.artist,
        title: normalized.title,
        url: normalized.url
      })
    });
    if (data && Array.isArray(data.removed_keys)) {
      for (let i = 0; i < data.removed_keys.length; i++) {
        const key = String(data.removed_keys[i] || "");
        if (key && removedKeys.indexOf(key) < 0) removedKeys.push(key);
      }
    }
    diggerDiagLog("info", "want remove ok", {
      step: "unwant",
      play: summarizeWantPlay(normalized),
      removedKeys: removedKeys
    });
    await setSyncStatus({ ok: true, lastError: "" });
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    diggerDiagLog("error", "want remove failed: " + String(err.message || err), {
      step: "unwant",
      play: summarizeWantPlay(normalized)
    });
    reportSyncError(err, "sync:unwant").catch(function () {});
  }

  if (removedKeys.length) {
    await mergeWantKeysIntoLocal(removedKeys, "remove");
    if (typeof invalidateRatingCache === "function") {
      invalidateRatingCache(removedKeys);
    }
  }
}

async function flushWantQueue() {
  const queue = await getWantQueue();
  if (!queue.length) return;
  try {
    const creds = await ensureSyncAccount();
    const batch = queue.slice(0, 100);
    diggerDiagLog("info", "want flush start", {
      step: "flush",
      batchSize: batch.length,
      batch: batch.map(summarizeWantPlay)
    });
    const data = await apiFetch("/v1/want-downloads", {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.apiKey },
      body: JSON.stringify({ plays: batch })
    });
    const remaining = (await getWantQueue()).slice(batch.length);
    await setWantQueue(remaining);
    const summary = summarizeWantApiResults(data);
    const metaEntries = [];
    const results = (data && data.results) || [];
    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      if (!row) continue;
      const play = batch[i] || {};
      const identity = parseWantIdentity({
        artist: row.artist || play.artist,
        title: row.title || play.title,
        rawTitle: play.rawTitle
      });
      metaEntries.push({
        artist: identity.artist || row.artist || play.artist || "",
        title: identity.title || row.title || play.title || "",
        fingerprint: identity.fingerprint,
        keys: row.keys || [],
        trackId: row.trackId || ""
      });
    }
    const merged = await mergeWantKeysIntoLocal(
      data && data.keys ? data.keys : [],
      "add",
      metaEntries
    );
    diggerDiagLog("info", "want flush ok", {
      step: "flush",
      api: summary,
      mergedLocalKeys: merged,
      metaFingerprints: metaEntries.map(function (m) {
        return m.fingerprint;
      }),
      crossPlatform:
        Array.isArray(summary.keys) &&
        summary.keys.some(function (k) {
          return String(k).indexOf("sc:") === 0;
        }) &&
        summary.keys.some(function (k) {
          return String(k).indexOf("sc:") !== 0;
        }),
      pendingCount: summary.results.filter(function (r) {
        return r.pending;
      }).length
    });
    broadcastMatchPrompts(data && data.results ? data.results : []);
    await setSyncStatus({
      ok: true,
      lastError: "",
      lastWantPushAt: syncNowMs(),
      lastWantPushCount: batch.length
    });
    if (remaining.length) scheduleSyncFlush();
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    diggerDiagLog("error", "want flush failed: " + String(err.message || err), {
      step: "flush"
    });
    reportSyncError(err, "sync:want-flush").catch(function () {});
  }
}

async function pullRemoteWants(force) {
  try {
    const creds = await ensureSyncAccount();
    const data = await apiFetch("/v1/want-downloads", {
      headers: { Authorization: "Bearer " + creds.apiKey }
    });
    const remoteKeys = (data && data.keys) || [];
    const metaEntries = [];
    const wants = (data && data.wants) || [];
    for (let i = 0; i < wants.length; i++) {
      const row = wants[i];
      if (!row) continue;
      const identity = parseWantIdentity({
        artist: row.artist,
        title: row.title,
        rawTitle: ""
      });
      metaEntries.push({
        artist: row.artist || "",
        title: row.title || "",
        fingerprint: identity.fingerprint,
        keys: row.keys || [],
        trackId: row.trackId || ""
      });
    }
    const added = await mergeWantKeysIntoLocal(remoteKeys, "add", metaEntries);
    diggerDiagLog("info", "want pull ok", {
      step: "pull",
      remoteCount: data && data.count != null ? data.count : remoteKeys.length,
      remoteKeys: remoteKeys.slice(0, 40),
      addedLocalKeys: added,
      metaCount: metaEntries.length,
      scKeys: remoteKeys.filter(function (k) {
        return String(k).indexOf("sc:") === 0;
      }).length,
      soundeoKeys: remoteKeys.filter(function (k) {
        return String(k).indexOf("sc:") !== 0;
      }).length
    });
    await setSyncStatus({
      ok: true,
      lastError: "",
      lastWantPullAt: syncNowMs(),
      remoteWantCount: data && data.count != null ? data.count : 0,
      wantPulledAdded: added.length
    });
    return { ok: true, added: added.length, count: data.count || 0 };
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    diggerDiagLog("error", "want pull failed: " + String(err.message || err), {
      step: "pull"
    });
    reportSyncError(err, "sync:want-pull").catch(function () {});
    if (force) throw err;
    return { ok: false, error: String(err.message || err) };
  }
}

async function flushPlayQueue() {
  if (syncInFlight) {
    scheduleSyncFlush();
    return;
  }
  const queue = await getPlayQueue();
  const wantQueue = await getWantQueue();
  if (!queue.length && !wantQueue.length) return;
  syncInFlight = true;
  try {
    if (queue.length) {
      const creds = await ensureSyncAccount();
      const batch = queue.slice(0, 100);
      const data = await apiFetch("/v1/plays", {
        method: "POST",
        headers: { Authorization: "Bearer " + creds.apiKey },
        body: JSON.stringify({ plays: batch })
      });
      const remaining = (await getPlayQueue()).slice(batch.length);
      await setPlayQueue(remaining);
      await mergeKeysIntoLocal(data && data.keys ? data.keys : []);
      broadcastMatchPrompts(data && data.results ? data.results : []);
      await setSyncStatus({
        ok: true,
        lastError: "",
        lastPushAt: syncNowMs(),
        lastPushCount: batch.length
      });
    }
    await flushWantQueue();
    const stillPlays = (await getPlayQueue()).length;
    const stillWants = (await getWantQueue()).length;
    if (stillPlays || stillWants) scheduleSyncFlush();
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    reportSyncError(err, "sync:play-flush").catch(function () {});
  } finally {
    syncInFlight = false;
  }
}

async function pullRemotePlays(force) {
  try {
    const creds = await ensureSyncAccount();
    const data = await apiFetch("/v1/plays/keys", {
      headers: { Authorization: "Bearer " + creds.apiKey }
    });
    const added = await mergeKeysIntoLocal(data && data.keys ? data.keys : []);
    await pullRemoteWants(false);
    await setSyncStatus({
      ok: true,
      lastError: "",
      lastPullAt: syncNowMs(),
      remoteCount: data && data.count != null ? data.count : 0,
      pulledAdded: added.length
    });
    return { ok: true, added: added.length, count: data.count || 0 };
  } catch (err) {
    await setSyncStatus({ ok: false, lastError: String(err.message || err) });
    reportSyncError(err, "sync:play-pull").catch(function () {});
    if (force) throw err;
    return { ok: false, error: String(err.message || err) };
  }
}

async function clearRemotePlays() {
  const creds = await ensureSyncAccount();
  await apiFetch("/v1/plays", {
    method: "DELETE",
    headers: { Authorization: "Bearer " + creds.apiKey }
  });
  await setPlayQueue([]);
  await setSyncStatus({ ok: true, lastError: "", remoteCount: 0 });
}

async function migrateLocalPlaysToQueue() {
  const played = await getPlayed();
  const keys = Object.keys(played || {});
  if (!keys.length) return 0;
  const queue = await getPlayQueue();
  const seen = new Set(
    queue.map(function (item) {
      return item.platform + "|" + item.externalId;
    })
  );
  let added = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let play;
    if (key.indexOf("sc:") === 0) {
      play = {
        platform: "soundcloud",
        externalId: key.slice(3),
        rawTitle: "",
        artist: "",
        title: "",
        url: "",
        playedAt: syncNowMs() / 1000
      };
    } else {
      play = {
        platform: "soundeo",
        externalId: key,
        rawTitle: "",
        artist: "",
        title: "",
        url: "",
        playedAt: syncNowMs() / 1000
      };
    }
    const dedupe = play.platform + "|" + play.externalId;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    queue.push(play);
    added++;
  }
  if (added) {
    await setPlayQueue(queue);
    scheduleSyncFlush();
  }
  return added;
}

async function getSyncInfo() {
  const creds = await getSyncCredentials();
  const local = await chrome.storage.local.get([
    SYNC_STATUS_KEY,
    SYNC_QUEUE_KEY,
    SYNC_WANT_QUEUE_KEY,
    WANT_STORAGE_KEY,
    WANT_META_KEY
  ]);
  const status = local[SYNC_STATUS_KEY] || {};
  const queue = Array.isArray(local[SYNC_QUEUE_KEY]) ? local[SYNC_QUEUE_KEY] : [];
  const wantQueue = Array.isArray(local[SYNC_WANT_QUEUE_KEY])
    ? local[SYNC_WANT_QUEUE_KEY]
    : [];
  const wants = local[WANT_STORAGE_KEY] || {};
  const wantMeta = local[WANT_META_KEY] || {};
  return {
    ok: true,
    userId: creds.userId,
    apiKey: creds.apiKey,
    queueLength: queue.length + wantQueue.length,
    wantCount: Object.keys(wants).length,
    wantMetaCount: Object.keys(wantMeta).length,
    status
  };
}

function initListenSync() {
  ensureSyncAccount()
    .then(function () {
      return migrateLocalPlaysToQueue();
    })
    .then(function () {
      return pullRemotePlays(false);
    })
    .then(function () {
      return flushPlayQueue();
    })
    .catch(function (err) {
      reportSyncError(err, "sync:init").catch(function () {});
    });

  clearInterval(syncPullTimer);
  syncPullTimer = setInterval(function () {
    pullRemotePlays(false).catch(function () {});
    flushPlayQueue().catch(function () {});
    if (typeof flushClientLogQueue === "function") {
      flushClientLogQueue().catch(function () {});
    }
    if (typeof flushSignalQueue === "function") {
      flushSignalQueue().catch(function () {});
    }
  }, 5 * 60 * 1000);
}
