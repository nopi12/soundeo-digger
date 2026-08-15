const RATE_ATTR = "data-digger-rate";
const HIDDEN_CLASS = "digger-sc-hidden-title";
const MARK_ATTR = "data-digger-sc-item";
const BAR_ID = "digger-sc-feed-bar";
const EXT_VERSION = "1.6.3";
const RATE_MIN = 0.8;
const RATE_MAX = 1.2;

const state = {
  playbackRate: 1,
  titleFilter: ""
};

let dead = false;
let scheduled = false;
let applying = false;
let rateSaveTimer = null;
let filterSaveTimer = null;
let trackObserver = null;
let barUi = null;
let lastPath = "";

function retire() {
  if (dead) return;
  dead = true;
  clearTimeout(rateSaveTimer);
  clearTimeout(filterSaveTimer);
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
    const items = getTrackItems();
    const filter = state.titleFilter;
    const hasFilter = Boolean(filter);
    let visible = 0;

    clearStaleMarks(items);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      item.setAttribute(MARK_ATTR, "1");
      const title = getItemTitle(item);
      const hide = hasFilter && title ? !titleMatches(title, filter) : false;
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
  if (!barUi) return;
  const offset = rateToOffset(state.playbackRate);
  try {
    if (barUi.slider && String(barUi.slider.value) !== String(offset)) {
      barUi.slider.value = String(offset);
    }
    if (barUi.rateLabel) barUi.rateLabel.textContent = formatOffset(offset);
    if (barUi.filterInput && barUi.filterInput.value !== state.titleFilter) {
      barUi.filterInput.value = state.titleFilter;
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
  }

  applyRateAll();
  ensureFeedBar();
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

function boot() {
  loadState();
  observeTracks();
  watchSpaNavigation();
}

if (document.body) boot();
else document.addEventListener("DOMContentLoaded", boot);
