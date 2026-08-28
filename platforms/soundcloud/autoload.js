const AUTO_LOAD_TICK_MS = 1200;

const autoLoad = {
  enabled: false,
  batches: 0,
  lastItemCount: 0,
  lastScrollHeight: 0,
  timerId: null,
  idleTicks: 0
};

function getFeedScrollHeight(root) {
  if (!root || root === document.documentElement || root === document.body) {
    return Math.max(
      document.documentElement.scrollHeight || 0,
      document.body.scrollHeight || 0
    );
  }
  return root.scrollHeight || 0;
}

function findFeedScrollRoot() {
  const items = getTrackItems();
  if (items.length) {
    let node = items[0];
    while (node && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const style = getComputedStyle(parent);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        parent.scrollHeight > parent.clientHeight + 4
      ) {
        return parent;
      }
      node = parent;
    }
  }
  return document.scrollingElement || document.documentElement;
}

function scrollFeedToEnd() {
  const root = findFeedScrollRoot();
  const isWindowScroll =
    root === document.documentElement ||
    root === document.body ||
    root === document.scrollingElement;
  const max = getFeedScrollHeight(isWindowScroll ? null : root);

  if (isWindowScroll) {
    window.scrollTo(0, max);
    document.documentElement.scrollTop = max;
    document.body.scrollTop = max;
  } else {
    root.scrollTop = max;
  }

  try {
    if (!isWindowScroll) root.dispatchEvent(new Event("scroll", { bubbles: true }));
  } catch (_) {}
  try {
    window.dispatchEvent(new Event("scroll"));
  } catch (_) {}
}

function noteAutoLoadActivity() {
  const count = getCachedFeedItemCount() || getTrackItems().length;
  const height = getFeedScrollHeight(findFeedScrollRoot());
  const grewItems = count > autoLoad.lastItemCount;
  const grewHeight = height > autoLoad.lastScrollHeight + 40;

  if (grewItems || grewHeight) {
    if (autoLoad.lastItemCount > 0 || autoLoad.lastScrollHeight > 0) {
      autoLoad.batches += 1;
    }
    autoLoad.lastItemCount = count;
    autoLoad.lastScrollHeight = height;
    autoLoad.idleTicks = 0;
  } else {
    autoLoad.idleTicks += 1;
  }
  updateAutoLoadUi();
}

function tickAutoLoad() {
  if (dead || !autoLoad.enabled) return;
  if (!isFeedPage()) {
    setAutoLoadEnabled(false);
    return;
  }
  scrollFeedToEnd();
  noteAutoLoadActivity();
}

function startAutoLoadTimer() {
  stopAutoLoadTimer();
  autoLoad.timerId = setInterval(tickAutoLoad, AUTO_LOAD_TICK_MS);
}

function stopAutoLoadTimer() {
  if (autoLoad.timerId == null) return;
  clearInterval(autoLoad.timerId);
  autoLoad.timerId = null;
}

function setAutoLoadEnabled(enabled) {
  const next = Boolean(enabled);
  if (autoLoad.enabled === next) {
    updateAutoLoadUi();
    return;
  }

  autoLoad.enabled = next;
  if (autoLoad.enabled) {
    if (!isFeedPage()) {
      autoLoad.enabled = false;
      updateAutoLoadUi();
      return;
    }
    autoLoad.batches = 0;
    autoLoad.idleTicks = 0;
    autoLoad.lastItemCount = getCachedFeedItemCount() || getTrackItems().length;
    autoLoad.lastScrollHeight = getFeedScrollHeight(findFeedScrollRoot());
    scrollFeedToEnd();
    startAutoLoadTimer();
    debugNote("autoLoad on · tracks=" + autoLoad.lastItemCount);
  } else {
    stopAutoLoadTimer();
    debugNote("autoLoad off · batches=" + autoLoad.batches);
  }
  updateAutoLoadUi();
}

function toggleAutoLoad() {
  setAutoLoadEnabled(!autoLoad.enabled);
}

function onAutoLoadDomChange() {
  if (dead || !autoLoad.enabled || !isFeedPage()) return;
  if (isHeavyFeed()) return;
  scrollFeedToEnd();
  noteAutoLoadActivity();
}

function onAutoLoadNavigation() {
  if (!autoLoad.enabled) return;
  if (!isFeedPage()) setAutoLoadEnabled(false);
}

function retireAutoLoad() {
  stopAutoLoadTimer();
  autoLoad.enabled = false;
}

function formatAutoLoadStatus() {
  if (!autoLoad.enabled) {
    return isFeedPage()
      ? "Feed nachladen (Hintergrund)"
      : "Nur auf /feed verfügbar";
  }
  const count = getCachedFeedItemCount() || getTrackItems().length;
  const idleHint =
    autoLoad.idleTicks >= 4 ? " · wartet auf SoundCloud" : " · lädt…";
  return (
    autoLoad.batches +
    " " +
    (autoLoad.batches === 1 ? "Batch" : "Batches") +
    " · " +
    count +
    " Tracks" +
    idleHint
  );
}

function updateAutoLoadUi() {
  try {
    if (barUi && barUi.autoLoadBtn) {
      barUi.autoLoadBtn.classList.toggle("is-active", autoLoad.enabled);
      barUi.autoLoadBtn.setAttribute("aria-pressed", autoLoad.enabled ? "true" : "false");
      barUi.autoLoadBtn.disabled = !isFeedPage();
      barUi.autoLoadBtn.title = isFeedPage()
        ? "Automatisch ans Feed-Ende springen und nachladen"
        : "Nur auf der Feed-Seite verfügbar";
    }
    if (barUi && barUi.autoLoadStatus) {
      barUi.autoLoadStatus.textContent = formatAutoLoadStatus();
      barUi.autoLoadStatus.classList.toggle("is-running", autoLoad.enabled);
    }
  } catch (_) {}
}
