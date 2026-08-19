const RATE_ATTR = "data-digger-rate";
const HIDDEN_CLASS = "digger-sc-hidden-title";
const MARK_ATTR = "data-digger-sc-item";
const BAR_ID = "digger-sc-feed-bar";
const PANEL_ID = "digger-sc-side-panel";
const SC_DURATION_EVENT = "digger:sc-duration-data";
const EXT_VERSION = "1.6.3";
const RATE_MIN = 0.8;
const RATE_MAX = 1.2;
const SET_MAX_SECONDS = 20 * 60;
const DURATION_ATTR = "data-digger-sc-duration";
const FREE_DOWNLOAD_RE = /\b(?:free\s*download|free\s*dl|edit)\b/i;

const state = {
  playbackRate: 1,
  titleFilter: "",
  hideSets: false,
  hideTracks: false,
  hideFreeDownloads: false
};

let dead = false;
let scheduled = false;
let applying = false;
let rateSaveTimer = null;
let filterSaveTimer = null;
let hideSetsSaveTimer = null;
let hideTracksSaveTimer = null;
let hideFreeDownloadsSaveTimer = null;
let trackObserver = null;
let barUi = null;
let panelUi = null;
let lastPath = "";
const durationByUrl = new Map();

function retire() {
  if (dead) return;
  dead = true;
  clearTimeout(rateSaveTimer);
  clearTimeout(filterSaveTimer);
  clearTimeout(hideSetsSaveTimer);
  clearTimeout(hideTracksSaveTimer);
  clearTimeout(hideFreeDownloadsSaveTimer);
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

function isFeedPage() {
  return /^\/feed(?:[/?#]|$)/.test(location.pathname);
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

function setHideSets(value, persist) {
  state.hideSets = Boolean(value);
  applyFilters();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(hideSetsSaveTimer);
  hideSetsSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_SC_HIDE_SETS",
      scHideSets: state.hideSets
    });
  }, 150);
}

function setHideTracks(value, persist) {
  state.hideTracks = Boolean(value);
  applyFilters();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(hideTracksSaveTimer);
  hideTracksSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_SC_HIDE_TRACKS",
      scHideTracks: state.hideTracks
    });
  }, 150);
}

function setHideFreeDownloads(value, persist) {
  state.hideFreeDownloads = Boolean(value);
  applyFilters();
  updateBarUi();
  if (!persist || dead) return;
  clearTimeout(hideFreeDownloadsSaveTimer);
  hideFreeDownloadsSaveTimer = setTimeout(function () {
    sendToBackground({
      type: "BG_SET_SC_HIDE_FREE_DOWNLOADS",
      scHideFreeDownloads: state.hideFreeDownloads
    });
  }, 150);
}

function resolveTrackRoot(node) {
  if (!node || node.nodeType !== 1) return null;
  return (
    node.closest("li.soundList__item") ||
    node.closest(".soundList__item") ||
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
      ".stream__list li.soundList__item, .stream li.soundList__item, li.soundList__item"
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
  return parseVerboseDurationToSeconds(text) || parseClockDurationToSeconds(text) || null;
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

function readDurationSeconds(item) {
  if (!item) return null;
  const cached = Number(item.getAttribute(DURATION_ATTR));
  if (Number.isFinite(cached) && cached > 0) return cached;

  const url = getTrackUrl(item);
  if (url) {
    const mapped = durationByUrl.get(url);
    if (Number.isFinite(mapped) && mapped > 0) {
      item.setAttribute(DURATION_ATTR, String(mapped));
      return mapped;
    }
  }

  const selectors = [
    '[aria-label*="Gesamte Zeit"]',
    '[aria-label*="Total time"]',
    ".playbackTimeline__duration span",
    ".soundBadge__additional",
    ".soundTitle__additionalContainer"
  ];
  for (let i = 0; i < selectors.length; i++) {
    const nodes = item.querySelectorAll(selectors[i]);
    for (let j = 0; j < nodes.length; j++) {
      const node = nodes[j];
      const fromLabel = parseDurationToSeconds(node.getAttribute("aria-label"));
      if (fromLabel) {
        item.setAttribute(DURATION_ATTR, String(fromLabel));
        return fromLabel;
      }
      const fromText = parseDurationToSeconds(node.textContent);
      if (fromText) {
        item.setAttribute(DURATION_ATTR, String(fromText));
        return fromText;
      }
    }
  }

  return null;
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

function seedDurationsFromScripts() {
  let scripts;
  try {
    scripts = document.querySelectorAll("script");
  } catch (_) {
    return;
  }
  const entries = [];
  for (let i = 0; i < scripts.length; i++) {
    const text = scripts[i].textContent || "";
    if (!text || text.indexOf("__sc_hydration") === -1) continue;
    const match = text.match(/window\.__sc_hydration(?:\w+)?\s*=\s*(\[[\s\S]*?\]);/);
    if (!match || !match[1]) continue;
    try {
      const parsed = JSON.parse(match[1]);
      collectHydrationEntries(parsed, entries, 0);
    } catch (_) {}
  }
  ingestDurationEntries(entries);
}

function shouldHideSet(item) {
  if (!state.hideSets && !state.hideTracks) return false;
  const seconds = readDurationSeconds(item);
  if (seconds != null) {
    if (state.hideSets && seconds > SET_MAX_SECONDS) return true;
    if (state.hideTracks && seconds <= SET_MAX_SECONDS) return true;
    return false;
  }
  return false;
}

function shouldHideFreeDownload(title) {
  if (!state.hideFreeDownloads) return false;
  return FREE_DOWNLOAD_RE.test(String(title || ""));
}

function setItemHidden(item, hide) {
  item.classList.toggle(HIDDEN_CLASS, hide);
  if (hide) {
    item.style.setProperty("display", "none", "important");
  } else {
    item.style.removeProperty("display");
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
  }
}

function applyFilters() {
  if (dead) return;
  applying = true;
  try {
    if (!isFeedPage()) {
      clearStaleMarks([]);
      if (barUi && barUi.meta) barUi.meta.textContent = "Nur im Feed aktiv";
      return;
    }
    const items = getTrackItems();
    const filter = state.titleFilter;
    const hasFilter =
      Boolean(filter) || state.hideSets || state.hideTracks || state.hideFreeDownloads;
    let visible = 0;

    clearStaleMarks(items);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      item.setAttribute(MARK_ATTR, "1");
      const title = getItemTitle(item);
      const hideByTitle = state.titleFilter && title ? !titleMatches(title, filter) : false;
      const hideByDuration = shouldHideSet(item);
      const hideByFreeDownload = shouldHideFreeDownload(title);
      const hide = hideByTitle || hideByDuration || hideByFreeDownload;
      setItemHidden(item, hide);
      if (!hide) visible += 1;
    }

    if (barUi && barUi.meta) {
      barUi.meta.textContent = hasFilter
        ? visible + " / " + items.length + " sichtbar"
        : items.length + " Tracks";
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
    if (!dead) {
      ensureFeedBar();
      ensureSidePanel();
      applyFilters();
    }
  });
}

function wireIsolation(root) {
  if (!root || root.dataset.overlayIso === "1") return;
  root.dataset.overlayIso = "1";
  const stop = function (e) {
    e.stopPropagation();
  };
  root.addEventListener("mousedown", stop, false);
  root.addEventListener("pointerdown", stop, false);
  root.addEventListener("click", stop, false);
  root.addEventListener("keydown", stop, false);
}

function updateBarUi() {
  const offset = rateToOffset(state.playbackRate);
  try {
    if (barUi && barUi.slider && String(barUi.slider.value) !== String(offset)) {
      barUi.slider.value = String(offset);
    }
    if (barUi && barUi.rateLabel) barUi.rateLabel.textContent = formatOffset(offset);
    if (barUi && barUi.filterInput && barUi.filterInput.value !== state.titleFilter) {
      barUi.filterInput.value = state.titleFilter;
    }
    if (panelUi && panelUi.setsCheckbox) panelUi.setsCheckbox.checked = state.hideSets;
    if (panelUi && panelUi.tracksCheckbox) panelUi.tracksCheckbox.checked = state.hideTracks;
    if (panelUi && panelUi.freeDownloadsCheckbox) {
      panelUi.freeDownloadsCheckbox.checked = state.hideFreeDownloads;
    }
    if (panelUi && panelUi.scopeHint) {
      panelUi.scopeHint.textContent = isFeedPage() ? "Nur im Feed aktiv" : "Im Feed verfugbar";
    }
  } catch (_) {}
}

function findStreamMount() {
  const list = document.querySelector(".stream__list");
  if (list && list.parentNode) {
    return { parent: list.parentNode, before: list };
  }
  const header = document.querySelector(".stream__header");
  if (header && header.parentNode) {
    return { parent: header.parentNode, before: header.nextSibling };
  }
  const stream = document.querySelector(".stream");
  if (stream) return { parent: stream, before: stream.firstChild };
  return null;
}

function ensureFeedBar() {
  if (dead) return;
  // Remove legacy floating overlay from older versions
  const legacy = document.getElementById("digger-sc-overlay");
  if (legacy) {
    try {
      legacy.remove();
    } catch (_) {}
  }
  const existing = document.getElementById(BAR_ID);
  const mount = findStreamMount();
  if (!mount) {
    // Feed DOM not ready yet — keep retrying via observer
    return;
  }

  if (existing) {
    if (existing.parentNode !== mount.parent || existing.nextSibling !== mount.before) {
      mount.parent.insertBefore(existing, mount.before);
    }
    if (!barUi || existing.dataset.wired !== "bar3") {
      bindBar(existing);
    }
    return;
  }

  injectFeedBar(mount);
}

function ensureSidePanel() {
  if (dead) return;
  const existing = document.getElementById(PANEL_ID);
  if (!isFeedPage()) {
    if (existing) existing.style.display = "none";
    return;
  }
  if (existing) {
    existing.style.display = "";
    if (!panelUi || existing.dataset.wired !== "panel1") {
      bindSidePanel(existing);
    }
    return;
  }
  injectSidePanel();
}

function bindBar(root) {
  barUi = {
    filterInput: root.querySelector(".digger-sc-filter-input"),
    clearBtn: root.querySelector(".digger-sc-clear-btn"),
    slider: root.querySelector(".digger-sc-rate-slider"),
    rateLabel: root.querySelector(".digger-sc-rate-value"),
    resetBtn: root.querySelector(".digger-sc-reset-btn"),
    meta: root.querySelector(".digger-sc-meta")
  };
  wireIsolation(root);
  updateBarUi();
}

function bindSidePanel(root) {
  panelUi = {
    setsCheckbox: root.querySelector(".digger-sc-sets-checkbox"),
    tracksCheckbox: root.querySelector(".digger-sc-tracks-checkbox"),
    freeDownloadsCheckbox: root.querySelector(".digger-sc-freedl-checkbox"),
    scopeHint: root.querySelector(".digger-sc-panel-hint")
  };
  wireIsolation(root);
  updateBarUi();
}

function injectFeedBar(mount) {
  const root = document.createElement("div");
  root.id = BAR_ID;
  root.dataset.wired = "bar3";
  root.style.cssText = [
    "display:flex",
    "flex-wrap:wrap",
    "align-items:center",
    "gap:10px",
    "margin:0 16px 12px",
    "padding:12px 14px",
    "border-radius:12px",
    "border:2px solid #ff5500",
    "background:#1a1f27",
    "box-shadow:0 4px 16px rgba(0,0,0,0.25)",
    "position:relative",
    "z-index:20",
    "font:600 12px Segoe UI,system-ui,sans-serif",
    "color:#e8edf4",
    "box-sizing:border-box"
  ].join(";");

  const label = document.createElement("span");
  label.textContent = "Digger";
  label.style.cssText =
    "color:#ff8a66;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;font-size:11px;";

  const filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.className = "digger-sc-filter-input";
  filterInput.placeholder = "Titel enthält…";
  filterInput.autocomplete = "off";
  filterInput.spellcheck = false;
  filterInput.value = state.titleFilter;
  filterInput.style.cssText = [
    "flex:1 1 220px",
    "min-width:180px",
    "height:36px",
    "padding:0 12px",
    "border-radius:10px",
    "border:1px solid #3a4554",
    "background:#12151a",
    "color:#e8edf4",
    "font:500 14px Segoe UI,system-ui,sans-serif",
    "outline:none"
  ].join(";");

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "digger-sc-clear-btn";
  clearBtn.textContent = "Leeren";
  clearBtn.style.cssText =
    "height:36px;padding:0 12px;border-radius:10px;border:1px solid #3a4554;background:rgba(255,85,0,0.16);color:#ff8a66;cursor:pointer;font:700 12px Segoe UI,system-ui,sans-serif;";

  const speedWrap = document.createElement("div");
  speedWrap.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 1 220px;";

  const speedLabel = document.createElement("span");
  speedLabel.textContent = "Speed";
  speedLabel.style.cssText = "color:#8b97a8;font-size:11px;text-transform:uppercase;";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "digger-sc-rate-slider";
  slider.min = "-20";
  slider.max = "20";
  slider.step = "1";
  slider.value = String(rateToOffset(state.playbackRate));
  slider.style.cssText = "flex:1;accent-color:#ff5500;cursor:pointer;";

  const rateLabel = document.createElement("span");
  rateLabel.className = "digger-sc-rate-value";
  rateLabel.textContent = formatOffset(rateToOffset(state.playbackRate));
  rateLabel.style.cssText = "min-width:40px;color:#ff5500;font-weight:700;";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "digger-sc-reset-btn";
  resetBtn.textContent = "0%";
  resetBtn.title = "Speed zurücksetzen";
  resetBtn.style.cssText =
    "height:28px;padding:0 8px;border-radius:999px;border:1px solid #3a4554;background:rgba(255,85,0,0.12);color:#ff8a66;cursor:pointer;font:700 11px Segoe UI,system-ui,sans-serif;";

  const meta = document.createElement("span");
  meta.className = "digger-sc-meta";
  meta.textContent = "Feed filtern";
  meta.style.cssText = "margin-left:auto;color:#8b97a8;font-size:11px;font-weight:500;";

  speedWrap.appendChild(speedLabel);
  speedWrap.appendChild(slider);
  speedWrap.appendChild(rateLabel);
  speedWrap.appendChild(resetBtn);

  root.appendChild(label);
  root.appendChild(filterInput);
  root.appendChild(clearBtn);
  root.appendChild(speedWrap);
  root.appendChild(meta);

  mount.parent.insertBefore(root, mount.before);

  barUi = {
    filterInput: filterInput,
    clearBtn: clearBtn,
    slider: slider,
    rateLabel: rateLabel,
    resetBtn: resetBtn,
    meta: meta
  };

  filterInput.addEventListener("input", function () {
    setTitleFilter(filterInput.value, true);
  });

  clearBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setTitleFilter("", true);
    filterInput.focus();
  });

  slider.addEventListener("input", function () {
    const offset = Number(slider.value) || 0;
    setPlaybackRate(1 + offset / 100, true);
  });

  resetBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setPlaybackRate(1, true);
  });

  wireIsolation(root);
  updateBarUi();
  console.info("[Digger] feed bar mounted");
}

function injectSidePanel() {
  const root = document.createElement("aside");
  root.id = PANEL_ID;
  root.dataset.wired = "panel1";

  const title = document.createElement("h3");
  title.className = "digger-sc-panel-title";
  title.textContent = "Anzeigen/Ausblenden";

  const toggle = document.createElement("label");
  toggle.className = "digger-sc-panel-toggle";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "digger-sc-sets-checkbox";
  checkbox.checked = state.hideSets;

  const toggleText = document.createElement("span");
  toggleText.className = "digger-sc-panel-toggle-text";
  toggleText.textContent = "Sets (> 20 min)";

  const tracksToggle = document.createElement("label");
  tracksToggle.className = "digger-sc-panel-toggle";

  const tracksCheckbox = document.createElement("input");
  tracksCheckbox.type = "checkbox";
  tracksCheckbox.className = "digger-sc-tracks-checkbox";
  tracksCheckbox.checked = state.hideTracks;

  const tracksText = document.createElement("span");
  tracksText.className = "digger-sc-panel-toggle-text";
  tracksText.textContent = "Tracks (<= 20 min)";

  const freeDlToggle = document.createElement("label");
  freeDlToggle.className = "digger-sc-panel-toggle";

  const freeDlCheckbox = document.createElement("input");
  freeDlCheckbox.type = "checkbox";
  freeDlCheckbox.className = "digger-sc-freedl-checkbox";
  freeDlCheckbox.checked = state.hideFreeDownloads;

  const freeDlText = document.createElement("span");
  freeDlText.className = "digger-sc-panel-toggle-text";
  freeDlText.textContent = "Free DL / Edit";

  const hint = document.createElement("p");
  hint.className = "digger-sc-panel-hint";
  hint.textContent = "Nur im Feed aktiv";

  toggle.appendChild(checkbox);
  toggle.appendChild(toggleText);
  tracksToggle.appendChild(tracksCheckbox);
  tracksToggle.appendChild(tracksText);
  freeDlToggle.appendChild(freeDlCheckbox);
  freeDlToggle.appendChild(freeDlText);
  root.appendChild(title);
  root.appendChild(toggle);
  root.appendChild(tracksToggle);
  root.appendChild(freeDlToggle);
  root.appendChild(hint);

  document.body.appendChild(root);

  panelUi = {
    setsCheckbox: checkbox,
    tracksCheckbox: tracksCheckbox,
    freeDownloadsCheckbox: freeDlCheckbox,
    scopeHint: hint
  };

  checkbox.addEventListener("change", function () {
    setHideSets(checkbox.checked, true);
  });
  tracksCheckbox.addEventListener("change", function () {
    setHideTracks(tracksCheckbox.checked, true);
  });
  freeDlCheckbox.addEventListener("change", function () {
    setHideFreeDownloads(freeDlCheckbox.checked, true);
  });

  wireIsolation(root);
  updateBarUi();
}

function observeTracks() {
  if (!document.body || dead) return;
  trackObserver = new MutationObserver(function () {
    if (dead || applying) return;
    scheduleApply();
  });
  trackObserver.observe(document.body, { childList: true, subtree: true });
}

function watchSpaNavigation() {
  lastPath = location.pathname + location.search;
  setInterval(function () {
    if (dead) return;
    const path = location.pathname + location.search;
    if (path === lastPath) return;
    lastPath = path;
    seedDurationsFromScripts();
    scheduleApply();
  }, 700);
}

async function loadState() {
  if (dead) return;
  const res = await sendToBackground({ type: "BG_GET_STATE" });
  if (dead) return;

  if (res && res.ok) {
    state.playbackRate = clampRate(res.playbackRate);
    state.titleFilter = sanitizeTitleFilter(res.scTitleFilter);
    state.hideSets = Boolean(res.scHideSets);
    state.hideTracks = Boolean(res.scHideTracks);
    state.hideFreeDownloads = Boolean(res.scHideFreeDownloads);
  }

  seedDurationsFromScripts();
  applyRateAll();
  ensureFeedBar();
  ensureSidePanel();
  applyFilters();

  const items = getTrackItems();
  console.info(
    "[Digger] SoundCloud ready · v" +
      EXT_VERSION +
      " · tracks=" +
      items.length +
      " · bar=" +
      Boolean(document.getElementById(BAR_ID))
  );
}

try {
  chrome.runtime.onMessage.addListener(function (message) {
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

    if (message.type === "RATE_CHANGED" || message.type === "SET_PLAYBACK_RATE") {
      setPlaybackRate(
        message.playbackRate != null ? message.playbackRate : message.value,
        false
      );
    }
    if (
      message.type === "SC_TITLE_FILTER_CHANGED" ||
      message.type === "SET_SC_TITLE_FILTER"
    ) {
      const next =
        "scTitleFilter" in message ? message.scTitleFilter : message.value;
      setTitleFilter(next, false);
    }
    if (message.type === "SC_HIDE_SETS_CHANGED" || message.type === "SET_SC_HIDE_SETS") {
      const next = "scHideSets" in message ? message.scHideSets : message.value;
      setHideSets(next, false);
    }
    if (message.type === "SC_HIDE_TRACKS_CHANGED" || message.type === "SET_SC_HIDE_TRACKS") {
      const next = "scHideTracks" in message ? message.scHideTracks : message.value;
      setHideTracks(next, false);
    }
    if (
      message.type === "SC_HIDE_FREE_DOWNLOADS_CHANGED" ||
      message.type === "SET_SC_HIDE_FREE_DOWNLOADS"
    ) {
      const next =
        "scHideFreeDownloads" in message ? message.scHideFreeDownloads : message.value;
      setHideFreeDownloads(next, false);
    }
  });
} catch (_) {
  retire();
}

// Popup/storage sync fallback
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (dead) return;
    if (area === "sync" && changes.scTitleFilter) {
      setTitleFilter(changes.scTitleFilter.newValue || "", false);
    }
    if (area === "sync" && changes.scHideSets) {
      setHideSets(Boolean(changes.scHideSets.newValue), false);
    }
    if (area === "sync" && changes.scHideTracks) {
      setHideTracks(Boolean(changes.scHideTracks.newValue), false);
    }
    if (area === "sync" && changes.scHideFreeDownloads) {
      setHideFreeDownloads(Boolean(changes.scHideFreeDownloads.newValue), false);
    }
    if (area === "local" && changes.playbackRate) {
      setPlaybackRate(changes.playbackRate.newValue, false);
    }
  });
} catch (_) {}

document.addEventListener(
  "play",
  function (e) {
    applyRateToEl(e.target);
  },
  true
);

window.addEventListener(SC_DURATION_EVENT, function (e) {
  if (!e || !e.detail) return;
  ingestDurationEntries(e.detail.tracks);
});

function boot() {
  loadState();
  observeTracks();
  watchSpaNavigation();
}

if (document.body) boot();
else document.addEventListener("DOMContentLoaded", boot);
