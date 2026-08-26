const FILTER_REV_ATTR = "data-digger-sc-filter-rev";
const HEAVY_FEED_THRESHOLD = 250;
const APPLY_DEBOUNCE_MS = 320;
const PRUNE_BATCH_SIZE = 120;

let filterRevision = 0;
let lastFilterKey = "";
let cachedItemCount = 0;
let pruneRemovedTotal = 0;
let applyDebounceTimer = null;
let pruneTimer = null;
let applyPassQueued = false;

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

function resetPerfSession() {
  pruneRemovedTotal = 0;
  cachedItemCount = 0;
}

function retirePerf() {
  clearTimeout(applyDebounceTimer);
  clearTimeout(pruneTimer);
  applyDebounceTimer = null;
  pruneTimer = null;
  applyPassQueued = false;
}

function runApplyPass(callback) {
  applyPassQueued = false;
  if (dead) return;
  callback();
}

function scheduleApplyPass(callback) {
  if (dead || applying) return;
  if (applyPassQueued && isHeavyFeed()) return;
  applyPassQueued = true;

  if (isHeavyFeed()) {
    clearTimeout(applyDebounceTimer);
    applyDebounceTimer = setTimeout(function () {
      applyDebounceTimer = null;
      runApplyPass(callback);
    }, APPLY_DEBOUNCE_MS);
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
      pruneRemovedTotal += 1;
    } catch (_) {}
  }
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
      document.querySelector(".stream") ||
      document.querySelector("[class*='stream__list']") ||
      null
    );
  } catch (_) {
    return null;
  }
}

function attachTrackObserver(onMutation) {
  const target = findTrackObserverTarget() || document.body;
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
