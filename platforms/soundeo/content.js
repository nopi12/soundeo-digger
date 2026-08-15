const HIDDEN_DOWNLOADED = "soundeo-digger-hidden-downloaded";
const HIDDEN_LISTENED = "soundeo-digger-hidden-listened";
const HIDDEN_BLOCKED = "soundeo-digger-hidden-blocked";
const PLAYED_ATTR = "data-soundeo-digger-played";
const FAV_ARTIST_ATTR = "data-soundeo-digger-fav-artist";
const RATE_ATTR = "data-digger-rate";
const HIDE_GRACE_MS = 10000;
const SKIP_SECONDS = 30;
const EXT_VERSION = "1.6.0";
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
  randomYears: 3
};

let dead = false;
let scheduled = false;
let applying = false;
let saveTimer = null;
let rateSaveTimer = null;
let targetBpmSaveTimer = null;
let artistSaveTimer = null;
let graceTrackId = null;
let graceTimer = null;
let trackObserver = null;
let tempoUi = null;
let bpmFetchToken = 0;

function retire() {
  if (dead) return;
  dead = true;
  clearTimeout(saveTimer);
  clearTimeout(rateSaveTimer);
  clearTimeout(targetBpmSaveTimer);
  clearTimeout(artistSaveTimer);
  clearTimeout(graceTimer);
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

function padDate(n) {
  return String(n).padStart(2, "0");
}

function formatDateYmd(date) {
  return (
    date.getFullYear() +
    "-" +
    padDate(date.getMonth() + 1) +
    "-" +
    padDate(date.getDate())
  );
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function weekRangeFromMonday(monday) {
  const start = startOfWeek(monday);
  const end = addDays(start, 7);
  return {
    start: start,
    end: end,
    filter: "r_" + formatDateYmd(start) + "_" + formatDateYmd(end)
  };
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function monthRangeFromStart(start) {
  const monthStart = startOfMonth(start);
  const end = addMonths(monthStart, 1);
  return {
    start: monthStart,
    end: end,
    filter: "r_" + formatDateYmd(monthStart) + "_" + formatDateYmd(end)
  };
}

function pickRandomWeekFilter(years) {
  const span = Math.max(1, Math.min(20, Number(years) || 3));
  const thisWeek = weekRangeFromMonday(new Date());
  const earliest = addDays(thisWeek.start, -span * 365);
  const earliestMonday = startOfWeek(earliest);
  const maxOffsetWeeks = Math.floor(
    (thisWeek.start - earliestMonday) / (7 * 24 * 60 * 60 * 1000)
  );
  const offset = Math.floor(Math.random() * (maxOffsetWeeks + 1));
  const randomMonday = addDays(earliestMonday, offset * 7);
  const week = weekRangeFromMonday(randomMonday);
  if (formatDateYmd(week.start) === formatDateYmd(thisWeek.start)) return "7";
  return week.filter;
}

function pickRandomMonthFilter(years) {
  const span = Math.max(1, Math.min(20, Number(years) || 3));
  const thisMonth = startOfMonth(new Date());
  const earliest = addMonths(thisMonth, -span * 12);
  const maxOffsetMonths =
    (thisMonth.getFullYear() - earliest.getFullYear()) * 12 +
    (thisMonth.getMonth() - earliest.getMonth());
  const offset = Math.floor(Math.random() * (maxOffsetMonths + 1));
  const randomMonthStart = addMonths(earliest, offset);
  return monthRangeFromStart(randomMonthStart).filter;
}

function buildTop100UrlWithTimeFilter(timeFilter) {
  let genreFilter = "";
  try {
    genreFilter = new URL(location.href).searchParams.get("genreFilter") || "";
  } catch (_) {}
  const params = new URLSearchParams({
    artistFilter: "",
    labelFilter: "",
    genreFilter: genreFilter,
    timeFilter: timeFilter,
    bpmFilter: "0,260",
    keyFilter: "",
    trackTypeFilter: "0",
    topTimeFilter: "0"
  });
  return "https://soundeo.com/top100?" + params.toString();
}

function goRandomWeek() {
  if (dead) return;
  const timeFilter = pickRandomWeekFilter(state.randomYears);
  const url = buildTop100UrlWithTimeFilter(timeFilter);
  if (tempoUi && tempoUi.meta) tempoUi.meta.textContent = "Random Week…";
  window.location.assign(url);
}

function goRandomMonth() {
  if (dead) return;
  const timeFilter = pickRandomMonthFilter(state.randomYears);
  const url = buildTop100UrlWithTimeFilter(timeFilter);
  if (tempoUi && tempoUi.meta) tempoUi.meta.textContent = "Random Month…";
  window.location.assign(url);
}

function wireOverlayIsolation(root) {
  if (!root || root.dataset.overlayIso === "1") return;
  root.dataset.overlayIso = "1";
  const stop = function (e) {
    e.stopPropagation();
  };
  root.addEventListener("mousedown", stop, false);
  root.addEventListener("pointerdown", stop, false);
  root.addEventListener("click", stop, false);
}

function injectTempoWidget() {
  if (dead || !document.body) return;
  let root = document.getElementById("soundeo-digger-tempo");
  if (root && root.dataset.wired !== "overlay2") {
    try {
      root.remove();
    } catch (_) {}
    root = null;
  }
  if (root && root.dataset.wired === "overlay2") {
    tempoUi = {
      slider: root.querySelector(".sd-tempo-slider"),
      label: root.querySelector(".sd-tempo-value"),
      meta: root.querySelector(".sd-tempo-meta"),
      randomWeek: root.querySelector(".sd-random-week-btn"),
      randomMonth: root.querySelector(".sd-random-month-btn")
    };
    wireOverlayIsolation(root);
    updateTempoUi();
    return;
  }

  root = document.createElement("div");
  root.id = "soundeo-digger-tempo";

  const row = document.createElement("div");
  row.className = "sd-tempo-row";

  const title = document.createElement("span");
  title.className = "sd-tempo-title";
  title.textContent = "BPM";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "sd-tempo-slider";
  slider.min = String(BPM_SLIDER_MIN);
  slider.max = String(BPM_SLIDER_MAX);
  slider.step = "1";
  slider.value = String(normalizeTargetBpm(state.targetBpm));

  const label = document.createElement("span");
  label.className = "sd-tempo-value";
  label.textContent = String(normalizeTargetBpm(state.targetBpm));

  row.appendChild(title);
  row.appendChild(slider);
  row.appendChild(label);

  const meta = document.createElement("span");
  meta.className = "sd-tempo-meta";
  meta.textContent = "Track-BPM…";

  const actions = document.createElement("div");
  actions.className = "sd-overlay-actions";

  const randomBtn = document.createElement("button");
  randomBtn.type = "button";
  randomBtn.className = "sd-random-week-btn";
  randomBtn.textContent = "Random Week";
  randomBtn.title = "Zufällige Woche (Jahre im Popup einstellbar)";
  randomBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    goRandomWeek();
  });

  const randomMonthBtn = document.createElement("button");
  randomMonthBtn.type = "button";
  randomMonthBtn.className = "sd-random-month-btn";
  randomMonthBtn.textContent = "Random Month";
  randomMonthBtn.title = "Zufälliger Monat (Jahre im Popup einstellbar)";
  randomMonthBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    goRandomMonth();
  });

  actions.appendChild(randomBtn);
  actions.appendChild(randomMonthBtn);
  root.appendChild(row);
  root.appendChild(meta);
  root.appendChild(actions);
  document.body.appendChild(root);

  root.dataset.wired = "overlay2";
  tempoUi = {
    slider: slider,
    label: label,
    meta: meta,
    randomWeek: randomBtn,
    randomMonth: randomMonthBtn
  };

  slider.addEventListener("input", function () {
    setTargetBpm(slider.value, true);
  });

  wireOverlayIsolation(root);

  updateTempoUi();
}

function getWavDownloadLink(item) {
  if (!item) return null;
  return (
    item.querySelector('.download a.track-download-lnk[data-track-format="2"]') ||
    item.querySelector('.download a[data-track-format="2"]')
  );
}

function triggerWavDownload(item) {
  const link = getWavDownloadLink(item);
  if (!link) return false;
  link.click();
  return true;
}

function trimSoundeoUi(item) {
  if (!item) return;
  const fav = item.querySelector("button.favorites");
  if (fav) fav.hidden = true;

  const download = item.querySelector(".download");
  if (download) download.classList.add("sd-download-hidden");

  const links = item.querySelectorAll(
    '.download a.track-download-lnk, .download a[data-track-format]'
  );
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const format = link.getAttribute("data-track-format");
    const text = (link.textContent || "").replace(/\s+/g, " ").trim();
    const isMp3 = format === "1" || /^MP3\b/i.test(text);
    if (!isMp3) continue;
    link.hidden = true;
    link.style.setProperty("display", "none", "important");
    link.setAttribute("aria-hidden", "true");
  }
}

function isTrackPlaying(item) {
  const btn = item.querySelector("button.action[data-track-id]");
  return Boolean(btn && btn.classList.contains("stop"));
}

function getPreviewAudio() {
  const nodes = document.querySelectorAll("audio");
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (!el.paused && !el.ended) return el;
  }
  return nodes.length ? nodes[nodes.length - 1] : null;
}

function skipPreviewBy(seconds) {
  const audio = getPreviewAudio();
  if (!audio) return false;
  applyRateToEl(audio);
  const max = Number.isFinite(audio.duration) ? audio.duration : audio.currentTime + seconds;
  audio.currentTime = Math.min(audio.currentTime + seconds, max);
  if (audio.paused) {
    try {
      audio.play();
    } catch (_) {}
  }
  return true;
}

function skipTrackPreview(item) {
  if (!item || dead) return;
  if (isTrackPlaying(item)) {
    skipPreviewBy(SKIP_SECONDS);
    return;
  }

  const playBtn = item.querySelector("button.action[data-track-id]");
  if (!playBtn) return;
  playBtn.click();

  let attempts = 0;
  const waitAndSkip = function () {
    if (dead) return;
    attempts += 1;
    const audio = getPreviewAudio();
    if (audio && (!audio.paused || audio.readyState >= 2)) {
      skipPreviewBy(SKIP_SECONDS);
      return;
    }
    if (attempts < 24) setTimeout(waitAndSkip, 50);
  };
  setTimeout(waitAndSkip, 50);
}

const SKIP_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M3 5v14l10-7L3 5zm10 0v14l10-7-10-7z"/>' +
  "</svg>";

function ensureSkipButton(item) {
  if (!item || dead) return;
  const playBtn = item.querySelector("button.action[data-track-id]");
  if (!playBtn) return;

  let wrap = item.querySelector(".sd-play-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "sd-play-wrap";
    playBtn.parentNode.insertBefore(wrap, playBtn);
    wrap.appendChild(playBtn);
  } else if (playBtn.parentNode !== wrap) {
    wrap.insertBefore(playBtn, wrap.firstChild);
  }

  let skipBtn = wrap.querySelector(".sd-skip-btn");
  if (!skipBtn) {
    skipBtn = item.querySelector(".sd-skip-btn");
  }
  if (!skipBtn) {
    skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "sd-skip-btn";
    skipBtn.title = "30 Sekunden vorspringen";
    skipBtn.setAttribute("aria-label", "30 Sekunden vorspringen");
    skipBtn.innerHTML = SKIP_ICON_SVG;
    skipBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        skipTrackPreview(item);
      },
      true
    );
  }

  if (skipBtn.parentNode !== wrap) {
    wrap.appendChild(skipBtn);
  }
}

function getArtistActionsAnchor(item) {
  return (
    item.querySelector("button.favorites") ||
    item.querySelector(".download") ||
    null
  );
}

function positionArtistActions(item, bar) {
  const anchor = getArtistActionsAnchor(item);
  if (!anchor) {
    if (!bar.parentNode) item.appendChild(bar);
    return;
  }
  if (bar.parentNode !== item || bar.nextElementSibling !== anchor) {
    item.insertBefore(bar, anchor);
  }
}

function isDownloaded(item) {
  return Boolean(item.querySelector(".download.downloaded"));
}

function ensureArtistActions(item) {
  if (!item || dead) return;
  trimSoundeoUi(item);

  let bar = null;
  try {
    bar = item.querySelector(":scope > .sd-artist-actions");
  } catch (_) {
    bar = item.querySelector(".sd-artist-actions");
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "sd-artist-actions";
    item.appendChild(bar);
  }

  let favBtn = bar.querySelector(".sd-artist-fav");
  if (!favBtn) {
    favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "sd-artist-btn sd-artist-fav";
    favBtn.title = "Artist favorisieren";
    favBtn.setAttribute("aria-label", "Artist favorisieren");
    favBtn.textContent = "★";
    favBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        const artists = getTrackArtists(item);
        if (!artists.length) return;
        toggleFavoriteArtists(artists);
      },
      true
    );
    bar.appendChild(favBtn);
  }

  let blockBtn = bar.querySelector(".sd-artist-block");
  if (!blockBtn) {
    blockBtn = document.createElement("button");
    blockBtn.type = "button";
    blockBtn.className = "sd-artist-btn sd-artist-block";
    blockBtn.title = "Artist blockieren";
    blockBtn.setAttribute("aria-label", "Artist blockieren");
    blockBtn.textContent = "✕";
    blockBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        const artists = getTrackArtists(item);
        if (!artists.length) return;
        toggleBlockedArtists(artists);
      },
      true
    );
    bar.appendChild(blockBtn);
  }

  let dlBtn = bar.querySelector(".sd-artist-download");
  if (!dlBtn) {
    dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "sd-artist-btn sd-artist-download";
    dlBtn.title = "WAV herunterladen";
    dlBtn.setAttribute("aria-label", "WAV herunterladen");
    dlBtn.textContent = "↓";
    dlBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        triggerWavDownload(item);
      },
      true
    );
    bar.appendChild(dlBtn);
  }

  positionArtistActions(item, bar);

  const blocked = trackHasBlockedArtist(item);
  const fav = trackHasFavoriteArtist(item);
  const downloaded = isDownloaded(item);
  if (favBtn) favBtn.classList.toggle("is-active", fav && !blocked);
  if (blockBtn) blockBtn.classList.toggle("is-active", blocked);
  if (dlBtn) {
    dlBtn.classList.toggle("is-downloaded", downloaded);
    dlBtn.title = downloaded ? "WAV herunterladen (bereits geladen)" : "WAV herunterladen";
  }
}

function applyFilters() {
  if (dead) return;
  applying = true;
  try {
    document.documentElement.classList.toggle(
      "soundeo-digger-hide-downloaded",
      state.hideDownloaded
    );
    document.documentElement.classList.toggle(
      "soundeo-digger-hide-listened",
      state.hideListened
    );

    const items = document.querySelectorAll(".trackitem");
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      ensureSkipButton(item);
      ensureArtistActions(item);

      const trackId = item.getAttribute("data-track-id");
      const id = trackId ? String(trackId) : null;
      const played = id ? state.playedIds.has(id) : false;
      const inGrace = id && id === graceTrackId;
      const blocked = trackHasBlockedArtist(item);
      const favArtist = !blocked && trackHasFavoriteArtist(item);

      if (played) item.setAttribute(PLAYED_ATTR, "");
      else item.removeAttribute(PLAYED_ATTR);

      if (favArtist) item.setAttribute(FAV_ARTIST_ATTR, "");
      else item.removeAttribute(FAV_ARTIST_ATTR);

      item.classList.toggle(
        HIDDEN_DOWNLOADED,
        state.hideDownloaded && isDownloaded(item)
      );
      item.classList.toggle(
        HIDDEN_LISTENED,
        state.hideListened && played && !inGrace
      );
      item.classList.toggle(HIDDEN_BLOCKED, blocked);
    }
  } finally {
    applying = false;
  }
}

function scheduleApply() {
  if (dead || scheduled || applying) return;
  scheduled = true;
  requestAnimationFrame(function () {
    scheduled = false;
    if (!dead) applyFilters();
  });
}

function persistPlayed() {
  if (dead) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    if (dead) return;
    const obj = {};
    state.playedIds.forEach(function (id) {
      obj[id] = true;
    });
    sendToBackground({ type: "BG_SET_PLAYED", playedTracks: obj });
  }, 250);
}

function startGrace(trackId) {
  const id = String(trackId);
  graceTrackId = id;
  clearTimeout(graceTimer);
  graceTimer = setTimeout(function () {
    if (dead) return;
    if (graceTrackId === id) {
      graceTrackId = null;
      applyFilters();
    }
  }, HIDE_GRACE_MS);
  applyFilters();
}

function clearGrace(trackId) {
  if (trackId && graceTrackId !== String(trackId)) return;
  clearTimeout(graceTimer);
  graceTimer = null;
  graceTrackId = null;
}

function markPlayed(trackId) {
  if (dead || !trackId) return;
  const id = String(trackId);
  if (!state.playedIds.has(id)) {
    state.playedIds.add(id);
    persistPlayed();
  }
  startGrace(id);
  resolveSourceBpm(id);
  setTimeout(applyRateAll, 40);
  setTimeout(applyRateAll, 250);
}

function unmarkPlayed(trackId) {
  if (dead || !trackId) return;
  const id = String(trackId);
  if (!state.playedIds.has(id)) return;
  state.playedIds.delete(id);
  if (graceTrackId === id) clearGrace();
  persistPlayed();
  applyFilters();
}

function onPlayClick(event) {
  if (dead) return;
  if (event.target.closest("#soundeo-digger-tempo, .sd-artist-actions, .sd-skip-btn")) return;
  const actionBtn = event.target.closest("button.action[data-track-id]");
  if (!actionBtn) return;
  markPlayed(actionBtn.getAttribute("data-track-id"));
}

function onManualToggle(event) {
  if (dead || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
  if (event.target.closest(".sd-artist-actions")) return;
  const item = event.target.closest(".trackitem[data-track-id]");
  if (!item) return;
  if (event.target.closest("a, button, .download")) return;
  event.preventDefault();
  event.stopPropagation();
  const id = item.getAttribute("data-track-id");
  if (state.playedIds.has(String(id))) unmarkPlayed(id);
  else markPlayed(id);
}

function onArtistGesture(event) {
  if (dead) return;
  if (event.target.closest(".sd-artist-actions")) return;
  if (event.altKey || event.metaKey) return;
  if (!event.ctrlKey && !event.shiftKey) return;
  if (event.target.closest("#soundeo-digger-tempo")) return;
  const item = event.target.closest(".trackitem");
  if (!item) return;
  if (event.target.closest("button, .download, input, textarea")) return;
  const artists = getTrackArtists(item);
  if (!artists.length) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.ctrlKey) toggleBlockedArtists(artists);
  else toggleFavoriteArtists(artists);
}

function observeTracks() {
  if (!document.body || dead) return;
  trackObserver = new MutationObserver(function () {
    if (dead || applying) return;
    scheduleApply();
  });
  trackObserver.observe(document.body, { childList: true, subtree: true });
}

async function loadState() {
  if (dead) return;
  const res = await sendToBackground({ type: "BG_GET_STATE" });
  if (dead || !res || !res.ok) return;

  state.hideDownloaded = Boolean(res.hideDownloaded);
  state.hideListened = Boolean(res.hideListened);
  state.playedIds = new Set(Object.keys(res.playedTracks || {}));
  state.playbackRate = clampRate(res.playbackRate);
  state.targetBpm = normalizeTargetBpm(res.targetBpm);
  state.bpmCache = res.bpmCache && typeof res.bpmCache === "object" ? res.bpmCache : {};
  state.blockedArtists = sanitizeArtistList(res.blockedArtists);
  state.favoriteArtists = sanitizeArtistList(res.favoriteArtists);
  state.randomYears = Math.max(1, Math.min(20, Number(res.randomYears) || 3));
  rebuildArtistKeys();
  applyFilters();
  applyRateAll();
  injectTempoWidget();
  applyTargetIfPossible(false);
  console.info("[Digger] Soundeo ready · v" + EXT_VERSION);
}

try {
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (dead) return;

    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        retire();
        return;
      }
    } catch (_) {
      retire();
      return;
    }

    if (!message || !message.type) return;

    if (message.type === "SET_HIDE_DOWNLOADED") {
      state.hideDownloaded = Boolean(message.value);
      applyFilters();
    }
    if (message.type === "SET_HIDE_LISTENED") {
      state.hideListened = Boolean(message.value);
      applyFilters();
    }
    if (message.type === "FLAGS_CHANGED") {
      if ("hideDownloaded" in message) {
        state.hideDownloaded = Boolean(message.hideDownloaded);
      }
      if ("hideListened" in message) {
        state.hideListened = Boolean(message.hideListened);
      }
      applyFilters();
    }
    if (message.type === "RATE_CHANGED" || message.type === "SET_PLAYBACK_RATE") {
      setPlaybackRate(message.playbackRate != null ? message.playbackRate : message.value, false);
    }
    if (message.type === "TARGET_BPM_CHANGED" || message.type === "SET_TARGET_BPM") {
      setTargetBpm(
        "targetBpm" in message ? message.targetBpm : message.value,
        false
      );
    }
    if (message.type === "ARTISTS_CHANGED" || message.type === "SET_ARTISTS") {
      if ("blockedArtists" in message) {
        state.blockedArtists = sanitizeArtistList(message.blockedArtists);
      }
      if ("favoriteArtists" in message) {
        state.favoriteArtists = sanitizeArtistList(message.favoriteArtists);
      }
      rebuildArtistKeys();
      applyFilters();
    }
    if (message.type === "CLEAR_PLAYED") {
      state.playedIds.clear();
      clearGrace();
      applyFilters();
      sendToBackground({ type: "BG_CLEAR_PLAYED" }).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    }
    if (message.type === "GET_PLAYED_COUNT") {
      sendResponse({ count: state.playedIds.size });
      return true;
    }
  });
} catch (_) {
  retire();
}

document.addEventListener("click", onPlayClick, true);
document.addEventListener("click", onManualToggle, true);
document.addEventListener("click", onArtistGesture, true);
document.addEventListener("click", function (e) {
  if (dead) return;
  const weekBtn = e.target.closest(".sd-random-week-btn");
  if (weekBtn) {
    e.preventDefault();
    e.stopPropagation();
    goRandomWeek();
    return;
  }
  const monthBtn = e.target.closest(".sd-random-month-btn");
  if (!monthBtn) return;
  e.preventDefault();
  e.stopPropagation();
  goRandomMonth();
}, true);
document.addEventListener("play", function (e) {
  applyRateToEl(e.target);
}, true);

function readPageBpm() {
  try {
    if (!/\/track\//.test(location.pathname)) return null;
    const cells = document.querySelectorAll("td");
    for (let i = 0; i < cells.length - 1; i++) {
      if (/^\s*BPM\s*$/i.test(cells[i].textContent || "")) {
        return parseBpmFromText(cells[i + 1].textContent);
      }
    }
  } catch (_) {}
  return null;
}

function boot() {
  loadState().then(function () {
    if (dead) return;
    const pageBpm = readPageBpm();
    if (pageBpm) {
      state.sourceBpm = pageBpm;
      applyTargetIfPossible(true);
    }
  });
  observeTracks();
}

if (document.body) boot();
else document.addEventListener("DOMContentLoaded", boot);
