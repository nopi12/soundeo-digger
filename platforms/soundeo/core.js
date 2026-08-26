const HIDDEN_DOWNLOADED = "soundeo-digger-hidden-downloaded";
const HIDDEN_LISTENED = "soundeo-digger-hidden-listened";
const HIDDEN_BLOCKED = "soundeo-digger-hidden-blocked";
const PLAYED_ATTR = "data-soundeo-digger-played";
const FAV_ARTIST_ATTR = "data-soundeo-digger-fav-artist";
const RATE_ATTR = "data-digger-rate";
const SKIP_SECONDS = 30;
const EXT_VERSION = "1.6.8";
const RATE_MIN = 0.8;
const RATE_MAX = 1.2;
const DEFAULT_TARGET_BPM = 120;
const BPM_SLIDER_MIN = 80;
const BPM_SLIDER_MAX = 160;

const state = {
  hideDownloaded: false,
  hideListened: false,
  playedIds: new Set(),
  playbackRate: 1,
  targetBpm: DEFAULT_TARGET_BPM,
  sourceBpm: null,
  currentTrackId: null,
  bpmCache: {},
  blockedArtists: [],
  favoriteArtists: [],
  blockedKeys: new Set(),
  favoriteKeys: new Set(),
  randomYears: 3,
  favoriteGenres: [],
  selectedFavoriteGenres: []
};

let dead = false;
let scheduled = false;
let applying = false;
let saveTimer = null;
let rateSaveTimer = null;
let targetBpmSaveTimer = null;
let artistSaveTimer = null;
let trackObserver = null;
let tempoUi = null;
let bpmFetchToken = 0;
let genreSaveTimer = null;

function retire() {
  if (dead) return;
  dead = true;
  clearTimeout(saveTimer);
  clearTimeout(rateSaveTimer);
  clearTimeout(targetBpmSaveTimer);
  clearTimeout(artistSaveTimer);
  clearTimeout(genreSaveTimer);
  if (trackObserver) {
    try {
      trackObserver.disconnect();
    } catch (_) {}
    trackObserver = null;
  }
}

function normalizeArtistKey(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function sanitizeArtistList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const name = String(list[i] || "").trim().replace(/\s+/g, " ");
    const key = normalizeArtistKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function rebuildArtistKeys() {
  state.blockedKeys = new Set(state.blockedArtists.map(normalizeArtistKey));
  state.favoriteKeys = new Set(state.favoriteArtists.map(normalizeArtistKey));
}

function setArtistLists(blocked, favorite, persist) {
  state.blockedArtists = sanitizeArtistList(blocked);
  state.favoriteArtists = sanitizeArtistList(favorite);
  rebuildArtistKeys();
  applyFilters();
  if (!persist || dead) return;
  clearTimeout(artistSaveTimer);
  artistSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_ARTISTS",
      blockedArtists: state.blockedArtists,
      favoriteArtists: state.favoriteArtists
    });
  }, 150);
}

function parseArtistsFromTitle(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const sep = raw.indexOf(" - ");
  const artistPart = (sep >= 0 ? raw.slice(0, sep) : raw).trim();
  if (!artistPart) return [];
  return artistPart
    .split(",")
    .map(function (part) {
      return part.trim();
    })
    .filter(Boolean);
}

function getTrackArtists(item) {
  if (!item) return [];
  const link =
    item.querySelector(".info strong a[href*='/track/']") ||
    item.querySelector(".info > strong > a") ||
    item.querySelector(".info strong a");
  if (!link) return [];
  return parseArtistsFromTitle(link.textContent);
}

function trackHasBlockedArtist(item) {
  const artists = getTrackArtists(item);
  for (let i = 0; i < artists.length; i++) {
    if (state.blockedKeys.has(normalizeArtistKey(artists[i]))) return true;
  }
  return false;
}

function trackHasFavoriteArtist(item) {
  const artists = getTrackArtists(item);
  for (let i = 0; i < artists.length; i++) {
    if (state.favoriteKeys.has(normalizeArtistKey(artists[i]))) return true;
  }
  return false;
}

function toggleNameInList(list, name) {
  const key = normalizeArtistKey(name);
  if (!key) return list.slice();
  const display = String(name).trim().replace(/\s+/g, " ");
  const next = [];
  let found = false;
  for (let i = 0; i < list.length; i++) {
    if (normalizeArtistKey(list[i]) === key) {
      found = true;
      continue;
    }
    next.push(list[i]);
  }
  if (!found) next.push(display);
  return next;
}

function removeNameFromList(list, name) {
  const key = normalizeArtistKey(name);
  return list.filter(function (item) {
    return normalizeArtistKey(item) !== key;
  });
}

function toggleBlockedArtists(artists) {
  let blocked = state.blockedArtists.slice();
  let favorite = state.favoriteArtists.slice();
  for (let i = 0; i < artists.length; i++) {
    const key = normalizeArtistKey(artists[i]);
    const wasBlocked = state.blockedKeys.has(key);
    blocked = toggleNameInList(blocked, artists[i]);
    if (!wasBlocked) favorite = removeNameFromList(favorite, artists[i]);
  }
  setArtistLists(blocked, favorite, true);
}

function toggleFavoriteArtists(artists) {
  let blocked = state.blockedArtists.slice();
  let favorite = state.favoriteArtists.slice();
  for (let i = 0; i < artists.length; i++) {
    const key = normalizeArtistKey(artists[i]);
    const wasFav = state.favoriteKeys.has(key);
    favorite = toggleNameInList(favorite, artists[i]);
    if (!wasFav) blocked = removeNameFromList(blocked, artists[i]);
  }
  setArtistLists(blocked, favorite, true);
}

function clampTargetBpm(bpm) {
  const n = Number(bpm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(BPM_SLIDER_MAX, Math.max(BPM_SLIDER_MIN, Math.round(n)));
}

function clampSourceBpm(bpm) {
  const n = Number(bpm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(300, Math.max(50, Math.round(n)));
}

function normalizeTargetBpm(bpm) {
  return clampTargetBpm(bpm) || DEFAULT_TARGET_BPM;
}

function parseBpmFromText(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{2,3}(?:\.\d+)?)/);
  return m ? clampSourceBpm(m[1]) : null;
}

function parseBpmFromHtml(html) {
  if (!html) return null;
  const patterns = [
    />\s*BPM\s*<\/td>\s*<td[^>]*>\s*<a[^>]*>\s*(\d{2,3}(?:\.\d+)?)/i,
    />\s*BPM\s*<\/td>\s*<td[^>]*>\s*(\d{2,3}(?:\.\d+)?)/i,
    /"bpm"\s*:\s*"?(\d{2,3}(?:\.\d+)?)"?/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = html.match(patterns[i]);
    if (m) return clampSourceBpm(m[1]);
  }
  return null;
}

function rateForTarget(sourceBpm, targetBpm) {
  const source = clampSourceBpm(sourceBpm);
  const target = normalizeTargetBpm(targetBpm);
  if (!source || !target) return null;
  return clampRate(target / source);
}

function findTrackItem(trackId) {
  if (!trackId) return null;
  try {
    return document.querySelector(
      '.trackitem[data-track-id="' + CSS.escape(String(trackId)) + '"]'
    );
  } catch (_) {
    return document.querySelector('.trackitem[data-track-id="' + String(trackId) + '"]');
  }
}

function getTrackUrl(item) {
  if (!item) return null;
  const link = item.querySelector('a[href*="/track/"]');
  if (!link) return null;
  try {
    return new URL(link.getAttribute("href"), location.origin).href;
  } catch (_) {
    return link.href || null;
  }
}

function readListBpm(item) {
  if (!item) return null;
  const bpmEl = item.querySelector(".bpm");
  return bpmEl ? parseBpmFromText(bpmEl.textContent) : null;
}

async function fetchTrackBpm(url) {
  if (!url || dead) return null;
  try {
    const res = await fetch(url, { credentials: "same-origin", cache: "force-cache" });
    if (!res.ok) return null;
    const html = await res.text();
    return parseBpmFromHtml(html);
  } catch (_) {
    return null;
  }
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    if (dead) {
      resolve(null);
      return;
    }
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        retire();
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        try {
          if (!chrome.runtime || !chrome.runtime.id) {
            retire();
            resolve(null);
            return;
          }
        } catch (_) {
          retire();
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (_) {
      retire();
      resolve(null);
    }
  });
}

function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, n));
}

function rateToOffset(rate) {
  return Math.round((clampRate(rate) - 1) * 100);
}

function formatOffset(offset) {
  if (offset > 0) return "+" + offset + "%";
  return offset + "%";
}

function applyRateToEl(el) {
  if (!el || (el.tagName !== "AUDIO" && el.tagName !== "VIDEO")) return;
  try {
    // Ableton-style re-pitch: pitch follows tempo
    if ("preservesPitch" in el) el.preservesPitch = false;
    if ("mozPreservesPitch" in el) el.mozPreservesPitch = false;
    if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = false;
    el.playbackRate = state.playbackRate;
  } catch (_) {}
}

function applyRateAll() {
  try {
    document.documentElement.setAttribute(RATE_ATTR, String(state.playbackRate));
  } catch (_) {}
  try {
    const nodes = document.querySelectorAll("audio, video");
    for (let i = 0; i < nodes.length; i++) applyRateToEl(nodes[i]);
  } catch (_) {}
  try {
    if (panelPreviewAudio) applyRateToEl(panelPreviewAudio);
  } catch (_) {}
}

function updateTempoUi() {
  if (!tempoUi) return;
  const target = normalizeTargetBpm(state.targetBpm);
  try {
    if (tempoUi.slider && String(tempoUi.slider.value) !== String(target)) {
      tempoUi.slider.value = String(target);
    }
    if (tempoUi.label) tempoUi.label.textContent = String(target);
    if (tempoUi.meta) {
      if (state.sourceBpm) {
        const ideal = target / state.sourceBpm;
        const clamped = ideal < RATE_MIN || ideal > RATE_MAX;
        const offset = rateToOffset(state.playbackRate);
        tempoUi.meta.textContent =
          state.sourceBpm +
          "→" +
          target +
          " · " +
          formatOffset(offset) +
          (clamped ? " lim" : "");
      } else {
        tempoUi.meta.textContent = "Track-BPM…";
      }
    }
  } catch (_) {}
}

function setPlaybackRate(rate, persist) {
  state.playbackRate = clampRate(rate);
  applyRateAll();
  updateTempoUi();
  if (!persist || dead) return;
  clearTimeout(rateSaveTimer);
  rateSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_PLAYBACK_RATE",
      playbackRate: state.playbackRate
    });
  }, 150);
}

function applyTargetIfPossible(persist) {
  state.targetBpm = normalizeTargetBpm(state.targetBpm);
  if (!state.sourceBpm) {
    updateTempoUi();
    return false;
  }
  const rate = rateForTarget(state.sourceBpm, state.targetBpm);
  if (rate == null) return false;
  setPlaybackRate(rate, persist);
  return true;
}

function setTargetBpm(bpm, persist) {
  state.targetBpm = normalizeTargetBpm(bpm);
  applyTargetIfPossible(persist);
  if (!persist || dead) return;
  clearTimeout(targetBpmSaveTimer);
  targetBpmSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_TARGET_BPM",
      targetBpm: state.targetBpm
    });
  }, 150);
}

function cacheBpm(trackId, bpm) {
  const id = trackId ? String(trackId) : null;
  const cached = clampSourceBpm(bpm);
  if (!id || !cached) return;
  state.bpmCache[id] = cached;
  sendToBackground({ type: "BG_CACHE_BPM", trackId: id, bpm: cached });
}

async function resolveSourceBpm(trackId) {
  const id = trackId ? String(trackId) : null;
  if (!id || dead) return null;

  if (state.bpmCache[id]) {
    state.sourceBpm = state.bpmCache[id];
    state.currentTrackId = id;
    applyTargetIfPossible(true);
    return state.sourceBpm;
  }

  const item = findTrackItem(id);
  const listBpm = readListBpm(item);
  if (listBpm) {
    state.sourceBpm = listBpm;
    state.currentTrackId = id;
    cacheBpm(id, listBpm);
    applyTargetIfPossible(true);
    return listBpm;
  }

  const url = getTrackUrl(item);
  if (!url) {
    state.currentTrackId = id;
    updateTempoUi();
    return null;
  }

  const token = ++bpmFetchToken;
  const fetched = await fetchTrackBpm(url);
  if (dead || token !== bpmFetchToken) return null;
  if (!fetched) {
    state.currentTrackId = id;
    updateTempoUi();
    return null;
  }

  state.sourceBpm = fetched;
  state.currentTrackId = id;
  cacheBpm(id, fetched);
  applyTargetIfPossible(true);
  return fetched;
}
