const RATE_ATTR = "data-digger-rate";
const HIDDEN_CLASS = "digger-sc-hidden-title";
const MARK_ATTR = "data-digger-sc-item";
const BAR_ID = "digger-sc-feed-bar";
const PANEL_ID = "digger-sc-side-panel";
const PLAYS_PANEL_ID = "digger-sc-plays-panel";
const DEBUG_ID = "digger-sc-debug-panel";
const ISOLATED_FORM_ID = "digger-sc-isolated-form";
const FIELD_IDS = {
  titleFilter: "digger-sc-title-filter",
  rateSlider: "digger-sc-rate-slider",
  onlySets: "digger-sc-only-sets",
  onlyTracks: "digger-sc-only-tracks",
  onlyFreeDl: "digger-sc-only-free-dl",
  minPlays: "digger-sc-min-plays",
  playsFilterMode: "digger-sc-plays-filter-mode"
};
const SC_DURATION_EVENT = "digger:sc-duration-data";
const EXT_VERSION = "1.23.0";
const RATE_MIN = 0.8;
const RATE_MAX = 1.2;
const SET_MAX_SECONDS = 20 * 60;
const DURATION_ATTR = "data-digger-sc-duration";
const DURATION_SRC_ATTR = "data-digger-sc-duration-src";
const HIDE_ATTR = "data-digger-sc-hidden";
const PLAYER_AREA_SELECTORS =
  "[class*='playbackTimeline'], [class*='soundPlayer'], .sound__player, .sound__waveform, [class*='waveform']";
const FEED_ONLY_MODES = {
  SETS: "sets",
  TRACKS: "tracks",
  FREE_DOWNLOADS: "freeDownloads"
};
const FREE_DOWNLOAD_RE = /\b(?:free(?:\s*(?:download|dl))?|edit)\b/i;

const state = {
  playbackRate: 1,
  titleFilter: "",
  feedOnlyMode: "",
  minPlays: 0,
  playsFilterMode: "min",
  hideListened: false,
  playedIds: new Set(),
  wantIds: new Set(),
  ratingsByKey: {},
  currentTrackUrl: null
};

let dead = false;
let applying = false;
let rateSaveTimer = null;
let filterSaveTimer = null;
let feedOnlyModeSaveTimer = null;
let trackObserver = null;
let barUi = null;
let panelUi = null;
let playsPanelUi = null;
let debugUi = null;
let lastPath = "";
let feedBarInjecting = false;
let sidePanelInjecting = false;
let playsPanelInjecting = false;
let overlayLayoutWired = false;
const durationByUrl = new Map();
const debugLog = [];
const DEBUG_LOG_MAX = 10;

function retire() {
  if (dead) return;
  dead = true;
  clearTimeout(rateSaveTimer);
  clearTimeout(filterSaveTimer);
  clearTimeout(feedOnlyModeSaveTimer);
  retirePlaysTimers();
  retireListened();
  retireAutoLoad();
  retirePerf();
  if (trackObserver) {
    try {
      trackObserver.disconnect();
    } catch (_) {}
    trackObserver = null;
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

function sanitizeTitleFilter(value) {
  return String(value || "").trim().slice(0, 120);
}

function dedupeElementById(id) {
  let first = null;
  try {
    const nodes = document.querySelectorAll("#" + CSS.escape(id));
    for (let i = 0; i < nodes.length; i++) {
      if (i === 0) first = nodes[i];
      else {
        try {
          nodes[i].remove();
        } catch (_) {}
      }
    }
  } catch (_) {
    first = document.getElementById(id);
  }
  return first;
}

function ensureIsolatedForm() {
  let form = dedupeElementById(ISOLATED_FORM_ID);
  if (!form) {
    form = document.createElement("form");
    form.id = ISOLATED_FORM_ID;
    form.hidden = true;
    form.setAttribute("aria-hidden", "true");
    form.style.display = "none";
    document.body.appendChild(form);
  }
  return form;
}

function assignIsolatedField(input, id, name) {
  dedupeElementById(id);
  input.id = id;
  input.name = name;
  input.setAttribute("form", ISOLATED_FORM_ID);
}

function dedupeOverlays() {
  dedupeElementById(BAR_ID);
  dedupeElementById(PANEL_ID);
  dedupeElementById(PLAYS_PANEL_ID);
  dedupeElementById(DEBUG_ID);
  ensureIsolatedForm();
}

function isFeedPage() {
  return /^\/feed(?:[/?#]|$)/.test(location.pathname);
}

function isUserProfilePage() {
  const parts = String(location.pathname || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (!parts.length) return false;
  const root = parts[0].toLowerCase();
  if (typeof SC_RESERVED_PATHS !== "undefined" && SC_RESERVED_PATHS.has(root)) {
    return false;
  }
  if (parts.length === 1) return true;
  const tab = parts[1].toLowerCase();
  return (
    tab === "tracks" ||
    tab === "popular-tracks" ||
    tab === "albums" ||
    tab === "sets" ||
    tab === "reposts" ||
    tab === "spotlight"
  );
}

function isWantEligiblePage() {
  return isFeedPage() || isUserProfilePage();
}

function rateToOffset(rate) {
  return Math.round((clampRate(rate) - 1) * 100);
}

function formatOffset(offset) {
  if (offset > 0) return "+" + offset + "%";
  return offset + "%";
}

function formatDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  return m + ":" + String(s).padStart(2, "0");
}

function classifyDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "?";
  return seconds > SET_MAX_SECONDS ? "set" : "track";
}

function updateDurationBadge(item, seconds, source) {
  if (!item) return;
  let badge = item.querySelector(":scope > .digger-sc-duration-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "digger-sc-duration-badge";
    item.insertBefore(badge, item.firstChild);
  }
  if (seconds == null) {
    badge.textContent = "Digger: ?";
    badge.dataset.kind = "unknown";
    return;
  }
  badge.textContent =
    "Digger: " +
    formatDurationLabel(seconds) +
    " · " +
    classifyDuration(seconds) +
    " · " +
    (source || "?");
  badge.dataset.kind = classifyDuration(seconds);
}

function removeDurationBadge(item) {
  if (!item) return;
  const badge = item.querySelector(":scope > .digger-sc-duration-badge");
  if (badge) badge.remove();
}

function applyRateToEl(el) {
  if (!el || (el.tagName !== "AUDIO" && el.tagName !== "VIDEO")) return;
  try {
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
}

function setPlaybackRate(rate, persist) {
  state.playbackRate = clampRate(rate);
  applyRateAll();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(rateSaveTimer);
  rateSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_PLAYBACK_RATE",
      playbackRate: state.playbackRate
    });
  }, 150);
}

function setTitleFilter(value, persist) {
  state.titleFilter = sanitizeTitleFilter(value);
  applyFilters();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(filterSaveTimer);
  filterSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_SC_TITLE_FILTER",
      scTitleFilter: state.titleFilter
    });
  }, 150);
}

function sanitizeFeedOnlyMode(value) {
  const mode = String(value || "").trim();
  if (
    mode === FEED_ONLY_MODES.SETS ||
    mode === FEED_ONLY_MODES.TRACKS ||
    mode === FEED_ONLY_MODES.FREE_DOWNLOADS
  ) {
    return mode;
  }
  return "";
}

function setFeedOnlyMode(value, persist) {
  const next = sanitizeFeedOnlyMode(value);
  if (state.feedOnlyMode === next) return;
  state.feedOnlyMode = next;
  debugNote("setFeedOnlyMode(" + JSON.stringify(state.feedOnlyMode) + ")");
  applyFilters();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(feedOnlyModeSaveTimer);
  feedOnlyModeSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_SC_FEED_ONLY_MODE",
      scFeedOnlyMode: state.feedOnlyMode
    });
  }, 150);
}

function resolveTrackRoot(node) {
  if (!node || node.nodeType !== 1) return null;
  return (
    node.closest("li.soundList__item") ||
    node.closest(".soundList__item") ||
    node.closest("li[class*='soundList__item']") ||
    node.closest("article[class*='sound']") ||
    null
  );
}

function getTrackItems() {
  const found = [];
  const seen = new Set();

  function add(node) {
    const root = resolveTrackRoot(node);
    if (!root || seen.has(root)) return;
    seen.add(root);
    found.push(root);
  }

  let listItems;
  try {
    listItems = document.querySelectorAll(
      ".stream__list li.soundList__item, .stream li.soundList__item, li.soundList__item, li[class*='soundList__item'], article[class*='sound']"
    );
  } catch (_) {
    listItems = [];
  }
  for (let i = 0; i < listItems.length; i++) add(listItems[i]);

  if (!found.length) {
    let waves;
    try {
      waves = document.querySelectorAll(".sound__waveform");
    } catch (_) {
      waves = [];
    }
    for (let i = 0; i < waves.length; i++) add(waves[i]);
  }

  return found;
}

function getItemTitle(item) {
  if (!item) return "";

  // Feed title link (confirmed from live DOM)
  const titleLink =
    item.querySelector("a.soundTitle__title") ||
    item.querySelector(".soundTitle__title");
  if (titleLink) {
    const span = titleLink.querySelector("span");
    const text = ((span || titleLink).textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }

  const titled = item.querySelector(".soundTitle[title]");
  if (titled) {
    const t = (titled.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    if (t) return t;
  }

  const group = item.querySelector('[role="group"][aria-label]');
  if (group) {
    const label = (group.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    // "Track: TITLE von ARTIST" / "Playlist: TITLE von ARTIST"
    const m = label.match(/^(?:Track|Playlist):\s*(.+?)\s+von\s+/i);
    if (m && m[1]) return m[1].replace(/&amp;/g, "&").trim();
    if (label) return label;
  }

  return "";
}

function titleMatches(title, filter) {
  const q = sanitizeTitleFilter(filter).toLowerCase();
  if (!q) return true;
  return String(title || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .includes(q);
}

function parseVerboseDurationToSeconds(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return null;
  let seconds = 0;
  const hourMatch = value.match(/(\d+)\s*(?:stunde|stunden|hour|hours)/i);
  const minuteMatch = value.match(/(\d+)\s*(?:minute|minuten|minute|minutes)/i);
  const secondMatch = value.match(/(\d+)\s*(?:sekunde|sekunden|second|seconds)/i);
  if (hourMatch) seconds += Number(hourMatch[1]) * 3600;
  if (minuteMatch) seconds += Number(minuteMatch[1]) * 60;
  if (secondMatch) seconds += Number(secondMatch[1]);
  return seconds > 0 ? seconds : null;
}

function parseClockDurationToSeconds(text) {
  const match = String(text || "")
    .trim()
    .match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = match[3] != null ? Number(match[3]) : null;
  if (c == null) return a * 60 + b;
  return a * 3600 + b * 60 + c;
}

function parseDurationToSeconds(text) {
  return (
    parseVerboseDurationToSeconds(text) ||
    parseCompactDurationToSeconds(text) ||
    parseClockDurationToSeconds(text) ||
    null
  );
}

function parseCompactDurationToSeconds(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return null;
  let seconds = 0;
  const hourMatch = value.match(/(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?|r\.?)?(?:\b|\s)/i);
  const minuteMatch = value.match(/(\d+(?:[.,]\d+)?)\s*m(?:in(?:ute)?s?)?(?:\b|\s)/i);
  const secondMatch = value.match(/(\d+(?:[.,]\d+)?)\s*s(?:ec(?:ond)?s?)?(?:\b|\s)/i);
  if (hourMatch) seconds += Math.round(parseFloat(hourMatch[1].replace(",", ".")) * 3600);
  if (minuteMatch) seconds += Math.round(parseFloat(minuteMatch[1].replace(",", ".")) * 60);
  if (secondMatch) seconds += Math.round(parseFloat(secondMatch[1].replace(",", ".")));
  return seconds > 0 ? seconds : null;
}

function readDurationFromMediaElement(item) {
  if (!item) return null;
  let audios;
  try {
    audios = item.querySelectorAll("audio");
  } catch (_) {
    return null;
  }
  for (let i = 0; i < audios.length; i++) {
    const duration = audios[i].duration;
    if (Number.isFinite(duration) && duration > 0 && duration !== Infinity) {
      return Math.round(duration);
    }
  }
  return null;
}

function readDurationFromPlayerArea(item) {
  if (!item) return null;
  let roots;
  try {
    roots = item.querySelectorAll(PLAYER_AREA_SELECTORS);
  } catch (_) {
    return null;
  }
  if (!roots.length) return null;

  let best = null;
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const clocks = (root.textContent || "").match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g) || [];
    for (let k = 0; k < clocks.length; k++) {
      const parsed = parseClockDurationToSeconds(clocks[k]);
      if (parsed != null && (best == null || parsed > best)) best = parsed;
    }
  }
  return best;
}

function resolveFilterDuration(item) {
  const candidates = [];
  const url = getTrackUrl(item);
  if (url) {
    const mapped = durationByUrl.get(url);
    if (Number.isFinite(mapped) && mapped > 0) {
      candidates.push({ seconds: mapped, source: "api" });
    }
  }

  const media = readDurationFromMediaElement(item);
  if (media != null) candidates.push({ seconds: media, source: "audio" });

  const player = readDurationFromPlayerArea(item);
  if (player != null) candidates.push({ seconds: player, source: "player" });

  const hmsMatches = (item.textContent || "").match(/\b(\d{1,2}:\d{2}:\d{2})\b/g) || [];
  for (let i = 0; i < hmsMatches.length; i++) {
    const parsed = parseClockDurationToSeconds(hmsMatches[i]);
    if (parsed != null) candidates.push({ seconds: parsed, source: "hms" });
  }

  if (!candidates.length) return { seconds: null, source: "none" };

  const rank = { api: 4, audio: 3, player: 2, hms: 1 };
  candidates.sort(function (a, b) {
    const rankDiff = (rank[b.source] || 0) - (rank[a.source] || 0);
    if (rankDiff !== 0) return rankDiff;
    return b.seconds - a.seconds;
  });
  return candidates[0];
}

function readFilterDurationSeconds(item) {
  if (!item) return null;
  const resolved = resolveFilterDuration(item);
  if (resolved.seconds != null) {
    item.setAttribute(DURATION_ATTR, String(resolved.seconds));
    item.setAttribute(DURATION_SRC_ATTR, resolved.source);
  } else {
    item.removeAttribute(DURATION_SRC_ATTR);
  }
  return resolved.seconds;
}

function readDurationSeconds(item) {
  return readFilterDurationSeconds(item);
}

function normalizeTrackUrl(url) {
  try {
    const parsed = new URL(url, location.origin);
    const path = parsed.pathname.replace(/\/+$/, "");
    return path || "/";
  } catch (_) {
    return null;
  }
}

function getTrackUrl(item) {
  if (!item) return null;
  const link =
    item.querySelector("a.soundTitle__title") ||
    item.querySelector(".soundTitle__title") ||
    item.querySelector('a[href^="/"]');
  if (!link) return null;
  try {
    return normalizeTrackUrl(new URL(link.getAttribute("href"), location.origin).href);
  } catch (_) {
    return normalizeTrackUrl(link.href || null);
  }
}

function ingestDurationEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  let changed = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const url = normalizeTrackUrl(entry.url || entry.permalink_url);
    const durationMs = Number(entry.durationMs != null ? entry.durationMs : entry.duration);
    if (!url || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    const seconds = Math.round(durationMs / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    if (durationByUrl.get(url) === seconds) continue;
    durationByUrl.set(url, seconds);
    changed = true;
  }
  if (ingestPlaysEntries(entries)) changed = true;
  if (changed) scheduleApply();
}

function collectHydrationEntries(value, out, depth) {
  if (!value || depth > 6) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectHydrationEntries(value[i], out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  if (typeof value.permalink_url === "string" && Number.isFinite(Number(value.duration))) {
    out.push({
      url: value.permalink_url,
      durationMs: Number(value.duration)
    });
  }
  const keys = ["data", "collection", "tracks", "track", "playlist", "items", "sounds", "sound"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key in value) collectHydrationEntries(value[key], out, depth + 1);
  }
}

function collectDurationPairsFromText(text, out, seen) {
  if (!text || text.indexOf("duration") === -1) return;
  const patterns = [
    /"permalink_url"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"[\s\S]{0,500}?"duration"\s*:\s*(\d+)/g,
    /"duration"\s*:\s*(\d+)[\s\S]{0,500}?"permalink_url"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"/g
  ];

  for (let p = 0; p < patterns.length; p++) {
    const re = patterns[p];
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const url = match[p === 0 ? 1 : 2];
      const durationMs = Number(match[p === 0 ? 2 : 1]);
      if (!url || !Number.isFinite(durationMs) || durationMs <= 0) continue;
      const key = url + "|d|" + durationMs;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: url.replace(/\\\//g, "/"), durationMs: durationMs });
    }
  }
}

function seedDurationsFromScripts() {
  let scripts;
  try {
    scripts = document.querySelectorAll("script");
  } catch (_) {
    return;
  }
  const entries = [];
  const seen = new Set();
  const playEntries = [];
  const playSeen = new Set();
  for (let i = 0; i < scripts.length; i++) {
    const text = scripts[i].textContent || "";
    if (!text) continue;
    collectDurationPairsFromText(text, entries, seen);
    collectPlaysPairsFromText(text, playEntries, playSeen);
    if (text.indexOf("__sc_hydration") === -1) continue;
    const match = text.match(/window\.__sc_hydration(?:\w+)?\s*=\s*(\[[\s\S]*?\]);/);
    if (!match || !match[1]) continue;
    try {
      const parsed = JSON.parse(match[1]);
      collectHydrationEntries(parsed, entries, 0);
      collectPlaysHydrationEntries(parsed, playEntries, 0);
    } catch (_) {}
  }
  ingestDurationEntries(entries.concat(playEntries));
}

function isFreeDownloadTitle(title) {
  const normalized = String(title || "")
    .toLowerCase()
    .replace(/&amp;/g, "&");
  if (!normalized) return false;
  return FREE_DOWNLOAD_RE.test(normalized);
}

function matchesFeedOnlyMode(item, title, secondsOverride) {
  const mode = state.feedOnlyMode;
  if (!mode) return true;

  if (mode === FEED_ONLY_MODES.FREE_DOWNLOADS) {
    return isFreeDownloadTitle(title);
  }

  const seconds =
    secondsOverride != null ? secondsOverride : readFilterDurationSeconds(item);
  if (seconds == null) return false;

  if (mode === FEED_ONLY_MODES.SETS) return seconds > SET_MAX_SECONDS;
  if (mode === FEED_ONLY_MODES.TRACKS) return seconds <= SET_MAX_SECONDS;
  return true;
}

function setItemHidden(item, hide) {
  if (!item) return;
  item.classList.toggle(HIDDEN_CLASS, hide);
  if (hide) {
    item.setAttribute(HIDE_ATTR, "1");
    item.setAttribute("aria-hidden", "true");
    item.style.setProperty("display", "none", "important");
    item.style.setProperty("visibility", "hidden", "important");
    item.style.setProperty("height", "0", "important");
    item.style.setProperty("margin", "0", "important");
    item.style.setProperty("padding", "0", "important");
    item.style.setProperty("overflow", "hidden", "important");
  } else {
    item.removeAttribute(HIDE_ATTR);
    item.removeAttribute("aria-hidden");
    item.style.removeProperty("display");
    item.style.removeProperty("visibility");
    item.style.removeProperty("height");
    item.style.removeProperty("margin");
    item.style.removeProperty("padding");
    item.style.removeProperty("overflow");
  }
}

function clearStaleMarks(activeRoots) {
  const active = new Set(activeRoots);
  let stale;
  try {
    stale = document.querySelectorAll("[" + MARK_ATTR + "]");
  } catch (_) {
    return;
  }
  for (let i = 0; i < stale.length; i++) {
    const el = stale[i];
    if (active.has(el)) continue;
    setItemHidden(el, false);
    el.removeAttribute(MARK_ATTR);
    el.removeAttribute(FILTER_REV_ATTR);
    removeDurationBadge(el);
  }
}

function applyWantButtonsOnly() {
  const t0 = performance.now();
  const items = getTrackItems();
  noteFeedItemCount(items.length);
  let wantBtns = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    applyWantMarkers(item);
    if (item.querySelector("." + WANT_BTN_CLASS)) wantBtns += 1;
  }
  collectAndApplyRatings(items);
  noteApplyPass(performance.now() - t0, items.length, items.length, 0, wantBtns);
}

function applyFilters() {
  if (dead) return;
  applying = true;
  const t0 = performance.now();
  let processed = 0;
  let skipped = 0;
  let wantBtns = 0;
  try {
    if (!isFeedPage()) {
      clearStaleMarks([]);
      if (isWantEligiblePage()) {
        applyWantButtonsOnly();
      } else {
        clearWantButtons();
        collectAndApplyRatings(getTrackItems());
      }
      if (barUi && barUi.meta) barUi.meta.textContent = "Nur im Feed aktiv";
      return;
    }
    const filterChanged = syncFilterRevision();
    const items = getTrackItems();
    noteFeedItemCount(items.length);
    const filter = state.titleFilter;
    const hasFilter =
      Boolean(filter) ||
      Boolean(state.feedOnlyMode) ||
      state.minPlays > 0 ||
      state.hideListened;
    const showBadges = shouldShowDurationBadges();
    let visible = 0;

    if (filterChanged) clearStaleMarks(items);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!itemNeedsProcessing(item, filterChanged)) {
        if (typeof needsWantSync === "function" && needsWantSync(item)) {
          applyWantMarkers(item);
        }
        if (typeof needsRatingSync === "function" && needsRatingSync(item)) {
          applyRatingBadge(item);
        }
        skipped += 1;
        if (item.querySelector("." + WANT_BTN_CLASS)) wantBtns += 1;
        if (!item.hasAttribute(HIDE_ATTR)) visible += 1;
        continue;
      }

      processed += 1;
      markItemFiltered(item);
      const title = getItemTitle(item);
      const resolved = resolveFilterDuration(item);
      const seconds = resolved.seconds;
      const plays = readFilterPlays(item);
      if (seconds != null) {
        item.setAttribute(DURATION_ATTR, String(seconds));
        item.setAttribute(DURATION_SRC_ATTR, resolved.source);
      } else {
        item.removeAttribute(DURATION_ATTR);
        item.removeAttribute(DURATION_SRC_ATTR);
      }
      if (showBadges) {
        updateDurationBadge(item, seconds, resolved.source);
      } else {
        removeDurationBadge(item);
      }
      const hideByTitle = state.titleFilter && title ? !titleMatches(title, filter) : false;
      const hideByFeedOnly = state.feedOnlyMode
        ? !matchesFeedOnlyMode(item, title, seconds)
        : false;
      const hideByPlays = state.minPlays > 0 ? !matchesPlaysFilter(item, plays) : false;
      applyListenedMarkers(item);
      applyWantMarkers(item);
      if (typeof applyRatingBadge === "function") applyRatingBadge(item);
      if (item.querySelector("." + WANT_BTN_CLASS)) wantBtns += 1;
      const hideByListened = shouldHideListenedItem(item);
      const hide = hideByTitle || hideByFeedOnly || hideByPlays || hideByListened;
      setItemHidden(item, hide);
      if (!hide) visible += 1;
    }

    if (typeof queueRatingLookup === "function") {
      const ratingKeys = [];
      for (let r = 0; r < items.length; r++) {
        const ratingKey = typeof itemRatingKey === "function" ? itemRatingKey(items[r]) : null;
        if (ratingKey) ratingKeys.push(ratingKey);
      }
      queueRatingLookup(ratingKeys);
    }

    if (barUi && barUi.meta) {
      let metaText = hasFilter
        ? visible + " / " + items.length + " sichtbar"
        : items.length + " Tracks";
      const pruned = getPruneRemovedTotal();
      if (pruned > 0) metaText += " · " + pruned + " entfernt";
      barUi.meta.textContent = metaText;
    }
    if (hasFilter) scheduleDomPrune(hasFilter);
    noteApplyPass(
      performance.now() - t0,
      items.length,
      processed,
      skipped,
      wantBtns
    );
  } finally {
    applying = false;
    suppressMutationEcho(80);
  }
}

function runLightScheduledWork() {
  applyFilters();
}

function runScheduledWork() {
  const mode = pendingApplyMode;
  pendingApplyMode = "light";
  if (mode === "full") {
    seedDurationsFromScripts();
    ensureFeedBar();
    ensureSidePanel();
    ensurePlaysPanel();
    ensureDebugPanel();
  }
  applyFilters();
  if (mode === "full") onAutoLoadDomChange();
}

function scheduleApply() {
  if (dead || applying) return;
  scheduleApplyPass(runScheduledWork, { mode: "full" });
}

function scheduleApplyFromMutation() {
  if (dead || applying || isMutationSuppressed()) return;
  scheduleApplyPass(runScheduledWork, {
    mode: "light",
    debounceMs: MUTATION_DEBOUNCE_MS
  });
}
