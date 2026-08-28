const PLAYS_ATTR = "data-digger-sc-plays";
const PLAYS_SRC_ATTR = "data-digger-sc-plays-src";
const PLAY_COUNT_RE =
  /([\d.,]+)\s*([KMBkmb])?\s*(?:plays?|play|wiedergaben?|mal\s+abgespielt)/i;
const PLAYS_FILTER_MODES = {
  MIN: "min",
  MAX: "max"
};

let minPlaysSaveTimer = null;
let playsFilterModeSaveTimer = null;
const playsByUrl = new Map();

function retirePlaysTimers() {
  clearTimeout(minPlaysSaveTimer);
  clearTimeout(playsFilterModeSaveTimer);
}

function isPlaysMaxMode() {
  return state.playsFilterMode === PLAYS_FILTER_MODES.MAX;
}

function formatPlayCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000000) {
    const scaled = n / 1000000;
    return (scaled % 1 === 0 ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, "")) + "M";
  }
  if (n >= 1000) {
    const scaled = n / 1000;
    return (scaled % 1 === 0 ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, "")) + "K";
  }
  return String(n);
}

function formatPlaysFilterLabel(threshold) {
  if (threshold <= 0) return "Aus";
  const formatted = formatPlayCount(threshold);
  return (isPlaysMaxMode() ? "≤ " : "≥ ") + formatted;
}

function getPlaysFilterIntro() {
  return isPlaysMaxMode()
    ? "Tracks mit mehr Plays ausblenden."
    : "Tracks mit weniger Plays ausblenden.";
}

function getPlaysFilterPlaceholder() {
  return isPlaysMaxMode() ? "Höchst-Plays…" : "Mindest-Plays…";
}

function applyCountSuffix(value, suffix) {
  const n = parseNumberWithSeparators(value);
  if (!Number.isFinite(n)) return null;
  const s = String(suffix || "").toUpperCase();
  if (s === "K") return Math.round(n * 1000);
  if (s === "M") return Math.round(n * 1000000);
  if (s === "B") return Math.round(n * 1000000000);
  return Math.round(n);
}

function parseNumberWithSeparators(value) {
  let text = String(value || "").trim();
  if (!text) return NaN;
  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (text.includes(",")) {
    const parts = text.split(",");
    if (parts.length === 2 && parts[1].length <= 2) text = parts[0] + "." + parts[1];
    else text = text.replace(/,/g, "");
  }
  return Number(text);
}

function parsePlayCountText(text) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return null;
  const match = value.match(PLAY_COUNT_RE);
  if (!match) return null;
  return applyCountSuffix(match[1], match[2]);
}

function setMinPlays(value, persist) {
  const next = sanitizeMinPlays(value);
  if (state.minPlays === next) return;
  state.minPlays = next;
  debugNote("setMinPlays(" + state.minPlays + ")");
  applyFilters();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(minPlaysSaveTimer);
  minPlaysSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_SC_MIN_PLAYS",
      scMinPlays: state.minPlays
    });
  }, 150);
}

function setPlaysFilterMode(value, persist) {
  const next = sanitizePlaysFilterMode(value);
  if (state.playsFilterMode === next) return;
  state.playsFilterMode = next;
  debugNote("setPlaysFilterMode(" + JSON.stringify(state.playsFilterMode) + ")");
  applyFilters();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(playsFilterModeSaveTimer);
  playsFilterModeSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_SC_PLAYS_FILTER_MODE",
      scPlaysFilterMode: state.playsFilterMode
    });
  }, 150);
}

function readPlaysFromDom(item) {
  if (!item) return null;

  let labeled;
  try {
    labeled = item.querySelectorAll("[aria-label]");
  } catch (_) {
    labeled = [];
  }
  for (let i = 0; i < labeled.length; i++) {
    const parsed = parsePlayCountText(labeled[i].getAttribute("aria-label"));
    if (parsed != null) return parsed;
  }

  let hidden;
  try {
    hidden = item.querySelectorAll(".sc-visuallyhidden");
  } catch (_) {
    hidden = [];
  }
  for (let i = 0; i < hidden.length; i++) {
    const parsed = parsePlayCountText(hidden[i].textContent);
    if (parsed != null) return parsed;
  }

  let stats;
  try {
    stats = item.querySelectorAll(
      ".soundStats, [class*='soundStats'], [class*='ministats'], [class*='playCount'], [class*='playbackCount']"
    );
  } catch (_) {
    stats = [];
  }
  for (let i = 0; i < stats.length; i++) {
    const parsed = parsePlayCountText(stats[i].textContent);
    if (parsed != null) return parsed;
  }

  return null;
}

function resolveFilterPlays(item) {
  const candidates = [];
  const url = getTrackUrl(item);
  if (url) {
    const mapped = playsByUrl.get(url);
    if (Number.isFinite(mapped) && mapped >= 0) {
      candidates.push({ plays: mapped, source: "api" });
    }
  }

  const dom = readPlaysFromDom(item);
  if (dom != null) candidates.push({ plays: dom, source: "dom" });

  if (!candidates.length) return { plays: null, source: "none" };

  const rank = { api: 2, dom: 1 };
  candidates.sort(function (a, b) {
    const rankDiff = (rank[b.source] || 0) - (rank[a.source] || 0);
    if (rankDiff !== 0) return rankDiff;
    return b.plays - a.plays;
  });
  return candidates[0];
}

function readFilterPlays(item) {
  if (!item) return null;
  const resolved = resolveFilterPlays(item);
  if (resolved.plays != null) {
    item.setAttribute(PLAYS_ATTR, String(resolved.plays));
    item.setAttribute(PLAYS_SRC_ATTR, resolved.source);
  } else {
    item.removeAttribute(PLAYS_ATTR);
    item.removeAttribute(PLAYS_SRC_ATTR);
  }
  return resolved.plays;
}

function storePlaysForUrl(url, playbackCount) {
  if (!url || !Number.isFinite(playbackCount) || playbackCount < 0) return false;
  const plays = Math.round(playbackCount);
  if (playsByUrl.get(url) === plays) return false;
  playsByUrl.set(url, plays);
  return true;
}

function ingestPlaysEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  let changed = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const url = normalizeTrackUrl(entry.url || entry.permalink_url);
    const playbackCount = Number(
      entry.playbackCount != null ? entry.playbackCount : entry.playback_count
    );
    if (storePlaysForUrl(url, playbackCount)) changed = true;
  }
  return changed;
}

function collectPlaysPairsFromText(text, out, seen) {
  if (!text || text.indexOf("playback_count") === -1) return;
  const playPatterns = [
    /"permalink_url"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"[\s\S]{0,500}?"playback_count"\s*:\s*(\d+)/g,
    /"playback_count"\s*:\s*(\d+)[\s\S]{0,500}?"permalink_url"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"/g
  ];

  for (let p = 0; p < playPatterns.length; p++) {
    const re = playPatterns[p];
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const url = match[p === 0 ? 1 : 2];
      const playbackCount = Number(match[p === 0 ? 2 : 1]);
      if (!url || !Number.isFinite(playbackCount) || playbackCount < 0) continue;
      const key = url + "|p|" + playbackCount;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url: url.replace(/\\\//g, "/"),
        playbackCount: playbackCount
      });
    }
  }
}

function appendPlaysHydrationEntry(value, out) {
  if (!value || typeof value !== "object") return;
  if (typeof value.permalink_url !== "string") return;
  if (!Number.isFinite(Number(value.playback_count))) return;
  out.push({
    url: value.permalink_url,
    playbackCount: Number(value.playback_count)
  });
}

function collectPlaysHydrationEntries(value, out, depth) {
  if (!value || depth > 6) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectPlaysHydrationEntries(value[i], out, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  appendPlaysHydrationEntry(value, out);
  const keys = ["data", "collection", "tracks", "track", "playlist", "items", "sounds", "sound"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key in value) collectPlaysHydrationEntries(value[key], out, depth + 1);
  }
}

function matchesPlaysFilter(item, playsOverride) {
  if (state.minPlays <= 0) return true;
  const plays = playsOverride != null ? playsOverride : readFilterPlays(item);
  if (plays == null) return false;
  if (isPlaysMaxMode()) return plays <= state.minPlays;
  return plays >= state.minPlays;
}
