const FILTER_REV_ATTR = "data-digger-sc-filter-rev";
const HEAVY_FEED_THRESHOLD = 250;
const APPLY_DEBOUNCE_MS = 320;
const MUTATION_DEBOUNCE_MS = 140;
const PRUNE_BATCH_SIZE = 120;
const PERF_SAMPLE_MAX = 40;

let filterRevision = 0;
let lastFilterKey = "";
let cachedItemCount = 0;
let pruneRemovedTotal = 0;
let applyDebounceTimer = null;
let pruneTimer = null;
let applyPassQueued = false;
let ignoreMutationsUntil = 0;
let pendingApplyMode = "full"; // "full" | "light"

const perfStats = {
  startedAt: Date.now(),
  applyCount: 0,
  applyLastMs: 0,
  applyMaxMs: 0,
  applyTotalMs: 0,
  applySamples: [],
  scheduleCount: 0,
  scheduleCoalesced: 0,
  mutationCount: 0,
  mutationIgnored: 0,
  mutationLastBatch: 0,
  mutationLastAt: 0,
  itemsLast: 0,
  processedLast: 0,
  skippedLast: 0,
  wantBtnLast: 0,
  pruneRuns: 0,
  pruneRemoved: 0,
  longFrames: 0,
  lastFrameMs: 0,
  maxFrameMs: 0,
  fps: 0,
  observerOnBody: false
};

let frameSamplePrev = 0;
let frameSampleCount = 0;
let frameSampleWindowStart = 0;
let longTaskObserver = null;
let perfRafId = 0;

function buildFilterKey() {
  return [
    state.titleFilter,
    state.feedOnlyMode,
    state.minPlays,
    state.playsFilterMode,
    state.hideListened ? "1" : "0"
  ].join("\0");
}

function syncFilterRevision() {
  const key = buildFilterKey();
  if (key === lastFilterKey) return false;
  lastFilterKey = key;
  filterRevision++;
  return true;
}

function noteFeedItemCount(count) {
  if (Number.isFinite(count) && count >= 0) cachedItemCount = count;
}

function getCachedFeedItemCount() {
  return cachedItemCount;
}

function isHeavyFeed() {
  return cachedItemCount >= HEAVY_FEED_THRESHOLD;
}

function itemNeedsProcessing(item, filterChanged) {
  if (filterChanged || !item.hasAttribute(MARK_ATTR)) return true;
  if (item.getAttribute(FILTER_REV_ATTR) !== String(filterRevision)) return true;
  return item.getAttribute(LISTENED_REV_ATTR) !== String(getListenedRevision());
}

function markItemFiltered(item) {
  item.setAttribute(MARK_ATTR, "1");
  item.setAttribute(FILTER_REV_ATTR, String(filterRevision));
  item.setAttribute(LISTENED_REV_ATTR, String(getListenedRevision()));
}

function shouldShowDurationBadges() {
  return Boolean(state.feedOnlyMode);
}

function getPruneRemovedTotal() {
  return pruneRemovedTotal;
}

function pushSample(list, value) {
  list.push(value);
  if (list.length > PERF_SAMPLE_MAX) list.shift();
}

function avgSample(list) {
  if (!list.length) return 0;
  let sum = 0;
  for (let i = 0; i < list.length; i++) sum += list[i];
  return sum / list.length;
}

function noteMutationBatch(size, ignored) {
  perfStats.mutationCount += 1;
  if (ignored) perfStats.mutationIgnored += 1;
  perfStats.mutationLastBatch = Number(size) || 0;
  perfStats.mutationLastAt = Date.now();
}

function suppressMutationEcho(ms) {
  const until = performance.now() + Math.max(0, Number(ms) || 0);
  if (until > ignoreMutationsUntil) ignoreMutationsUntil = until;
}

function isMutationSuppressed() {
  return performance.now() < ignoreMutationsUntil;
}

function isDiggerNode(node) {
  if (!node || node.nodeType !== 1) return false;
  try {
    if (node.id === BAR_ID || node.id === PANEL_ID || node.id === PLAYS_PANEL_ID || node.id === DEBUG_ID) {
      return true;
    }
    if (node.classList && (
      node.classList.contains(WANT_BTN_CLASS) ||
      node.classList.contains("digger-sc-duration-badge") ||
      node.classList.contains("digger-sc-debug-panel") ||
      node.classList.contains("digger-sc-hidden-title") ||
      node.classList.contains("digger-sc-score-item") ||
      node.classList.contains("digger-sc-score")
    )) {
      return true;
    }
    if (
      node.hasAttribute &&
      (node.hasAttribute(MARK_ATTR) ||
        node.hasAttribute(HIDE_ATTR) ||
        node.hasAttribute(WANT_ATTR) ||
        node.hasAttribute(PLAYED_ATTR) ||
        node.hasAttribute(DURATION_ATTR) ||
        node.hasAttribute(FILTER_REV_ATTR) ||
        node.hasAttribute(LISTENED_REV_ATTR))
    ) {
      // Feed items themselves are not "digger owned"; only pure digger chrome above.
      return false;
    }
  } catch (_) {}
  return false;
}

function mutationLooksRelevant(mutations) {
  if (!mutations || !mutations.length) return false;
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (m.type === "childList") {
      const nodes = [];
      if (m.addedNodes && m.addedNodes.length) {
        for (let j = 0; j < m.addedNodes.length; j++) nodes.push(m.addedNodes[j]);
      }
      if (m.removedNodes && m.removedNodes.length) {
        for (let j = 0; j < m.removedNodes.length; j++) nodes.push(m.removedNodes[j]);
      }
      for (let j = 0; j < nodes.length; j++) {
        const node = nodes[j];
        if (!node || node.nodeType !== 1) continue;
        if (isDiggerNode(node)) continue;
        // New feed rows / content from SoundCloud
        if (
          (node.matches &&
            (node.matches("li.soundList__item") ||
              node.matches("li[class*='soundList__item']") ||
              node.matches("article") ||
              node.matches(".soundTitle__title") ||
              node.matches("[class*='soundList']"))) ||
          (node.querySelector &&
            node.querySelector("li.soundList__item, li[class*='soundList__item'], .soundTitle__title"))
        ) {
          return true;
        }
        // Generic non-digger element under stream — treat as relevant
        if (!node.closest || !node.closest("#" + BAR_ID + ", #" + PANEL_ID + ", #" + PLAYS_PANEL_ID + ", #" + DEBUG_ID)) {
          if (!node.classList || !String(node.className || "").includes("digger-sc-")) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function noteScheduleApply(coalesced) {
  perfStats.scheduleCount += 1;
  if (coalesced) perfStats.scheduleCoalesced += 1;
}

function noteApplyPass(ms, itemCount, processed, skipped, wantBtns) {
  const duration = Math.max(0, Number(ms) || 0);
  perfStats.applyCount += 1;
  perfStats.applyLastMs = duration;
  perfStats.applyTotalMs += duration;
  if (duration > perfStats.applyMaxMs) perfStats.applyMaxMs = duration;
  pushSample(perfStats.applySamples, duration);
  perfStats.itemsLast = itemCount || 0;
  perfStats.processedLast = processed || 0;
  perfStats.skippedLast = skipped || 0;
  perfStats.wantBtnLast = wantBtns || 0;
  scheduleDebugPerfRefresh();
}

function notePruneBatch(removed) {
  perfStats.pruneRuns += 1;
  perfStats.pruneRemoved += removed || 0;
  pruneRemovedTotal += removed || 0;
}

function getPerfStats() {
  return perfStats;
}

function formatPerfMs(ms) {
  return (Math.round((Number(ms) || 0) * 10) / 10).toFixed(1) + "ms";
}

function onPerfFrame(ts) {
  if (dead) {
    perfRafId = 0;
    return;
  }
  if (frameSamplePrev) {
    const delta = ts - frameSamplePrev;
    perfStats.lastFrameMs = delta;
    if (delta > perfStats.maxFrameMs) perfStats.maxFrameMs = delta;
    if (delta > 50) perfStats.longFrames += 1;
    frameSampleCount += 1;
    if (!frameSampleWindowStart) frameSampleWindowStart = ts;
    const windowMs = ts - frameSampleWindowStart;
    if (windowMs >= 1000) {
      perfStats.fps = Math.round((frameSampleCount * 1000) / windowMs);
      frameSampleCount = 0;
      frameSampleWindowStart = ts;
      scheduleDebugPerfRefresh();
    }
  }
  frameSamplePrev = ts;
  perfRafId = requestAnimationFrame(onPerfFrame);
}

function startPerfMonitors() {
  if (!perfRafId) {
    frameSamplePrev = 0;
    frameSampleCount = 0;
    frameSampleWindowStart = 0;
    perfRafId = requestAnimationFrame(onPerfFrame);
  }
  if (longTaskObserver || typeof PerformanceObserver !== "function") return;
  try {
    longTaskObserver = new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        if ((entries[i].duration || 0) > 50) perfStats.longFrames += 1;
      }
      scheduleDebugPerfRefresh();
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch (_) {
    longTaskObserver = null;
  }
}

function resetPerfSession() {
  pruneRemovedTotal = 0;
  cachedItemCount = 0;
  perfStats.startedAt = Date.now();
  perfStats.applyCount = 0;
  perfStats.applyLastMs = 0;
  perfStats.applyMaxMs = 0;
  perfStats.applyTotalMs = 0;
  perfStats.applySamples = [];
  perfStats.scheduleCount = 0;
  perfStats.scheduleCoalesced = 0;
  perfStats.mutationCount = 0;
  perfStats.mutationIgnored = 0;
  perfStats.mutationLastBatch = 0;
  perfStats.mutationLastAt = 0;
  perfStats.itemsLast = 0;
  perfStats.processedLast = 0;
  perfStats.skippedLast = 0;
  perfStats.wantBtnLast = 0;
  perfStats.pruneRuns = 0;
  perfStats.pruneRemoved = 0;
  perfStats.longFrames = 0;
  perfStats.lastFrameMs = 0;
  perfStats.maxFrameMs = 0;
  perfStats.fps = 0;
}

function retirePerf() {
  clearTimeout(applyDebounceTimer);
  clearTimeout(pruneTimer);
  applyDebounceTimer = null;
  pruneTimer = null;
  applyPassQueued = false;
  if (perfRafId) {
    try {
      cancelAnimationFrame(perfRafId);
    } catch (_) {}
    perfRafId = 0;
  }
  if (longTaskObserver) {
    try {
      longTaskObserver.disconnect();
    } catch (_) {}
    longTaskObserver = null;
  }
}

function runApplyPass(callback) {
  applyPassQueued = false;
  if (dead) return;
  callback();
}

function scheduleApplyPass(callback, options) {
  if (dead || applying) return;
  const opts = options || {};
  const debounceMs = Number(opts.debounceMs);
  const mode = opts.mode === "light" ? "light" : "full";
  if (mode === "full") pendingApplyMode = "full";
  else if (pendingApplyMode !== "full") pendingApplyMode = "light";

  if (applyPassQueued) {
    noteScheduleApply(true);
    // Upgrade queued light pass to full if requested
    if (mode === "full") pendingApplyMode = "full";
    return;
  }
  noteScheduleApply(false);
  applyPassQueued = true;

  const wait =
    Number.isFinite(debounceMs) && debounceMs > 0
      ? debounceMs
      : isHeavyFeed()
        ? APPLY_DEBOUNCE_MS
        : 0;

  if (wait > 0) {
    clearTimeout(applyDebounceTimer);
    applyDebounceTimer = setTimeout(function () {
      applyDebounceTimer = null;
      runApplyPass(callback);
    }, wait);
    return;
  }

  requestAnimationFrame(function () {
    runApplyPass(callback);
  });
}

function scheduleDomPrune(hasFilter) {
  if (!hasFilter || !isHeavyFeed() || dead) return;
  if (pruneTimer) return;
  pruneTimer = setTimeout(function () {
    pruneTimer = null;
    pruneHiddenBatch(hasFilter);
  }, 400);
}

function pruneHiddenBatch(hasFilter) {
  if (dead || !hasFilter || !isFeedPage()) return;

  let hidden;
  try {
    hidden = document.querySelectorAll("[" + HIDE_ATTR + '="1"]');
  } catch (_) {
    return;
  }
  if (!hidden.length) return;

  const batch = Math.min(hidden.length, PRUNE_BATCH_SIZE);
  for (let i = 0; i < batch; i++) {
    try {
      hidden[i].remove();
    } catch (_) {}
  }
  notePruneBatch(batch);
  cachedItemCount = Math.max(0, cachedItemCount - batch);

  if (hidden.length > batch) {
    scheduleDomPrune(hasFilter);
  } else if (barUi && barUi.meta) {
    scheduleApply();
  }
}

function findTrackObserverTarget() {
  try {
    return (
      document.querySelector(".stream__list") ||
      document.querySelector(".userStream__list") ||
      document.querySelector(".lazyLoadingList__list") ||
      document.querySelector(".soundList.sc-list-nostyle") ||
      document.querySelector(".soundList") ||
      document.querySelector(".stream") ||
      document.querySelector("[class*='stream__list']") ||
      document.querySelector("[class*='userStream']") ||
      null
    );
  } catch (_) {
    return null;
  }
}

function attachTrackObserver(onMutation) {
  const target = findTrackObserverTarget() || document.body;
  perfStats.observerOnBody = target === document.body;
  if (trackObserver) {
    try {
      trackObserver.disconnect();
    } catch (_) {}
  }
  trackObserver = new MutationObserver(onMutation);
  trackObserver.observe(target, { childList: true, subtree: true });
  return target !== document.body;
}

function ensureTrackObserverTarget(onMutation) {
  if (dead || !trackObserver) return;
  const target = findTrackObserverTarget();
  if (!target) return;
  attachTrackObserver(onMutation);
}
