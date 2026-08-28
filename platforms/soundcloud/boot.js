function observeTracks() {
  if (!document.body || dead) return;

  function onMutations(mutations) {
    if (dead || applying || isMutationSuppressed()) {
      noteMutationBatch(mutations && mutations.length ? mutations.length : 0, true);
      return;
    }
    const relevant = mutationLooksRelevant(mutations);
    noteMutationBatch(mutations && mutations.length ? mutations.length : 0, !relevant);
    if (!relevant) return;
    scheduleApplyFromMutation();
  }

  attachTrackObserver(onMutations);

  if (!findTrackObserverTarget()) {
    const retryTimer = setInterval(function () {
      if (dead) {
        clearInterval(retryTimer);
        return;
      }
      if (findTrackObserverTarget()) {
        ensureTrackObserverTarget(onMutations);
        clearInterval(retryTimer);
      }
    }, 2000);
  }
}

function watchSpaNavigation() {
  lastPath = location.pathname + location.search;
  setInterval(function () {
    if (dead) return;
    const path = location.pathname + location.search;
    if (path === lastPath) return;
    lastPath = path;
    resetPerfSession();
    seedDurationsFromScripts();
    onAutoLoadNavigation();
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
    state.feedOnlyMode = sanitizeFeedOnlyMode(res.scFeedOnlyMode);
    state.minPlays = sanitizeMinPlays(res.scMinPlays);
    state.playsFilterMode = sanitizePlaysFilterMode(res.scPlaysFilterMode);
    state.hideListened = Boolean(res.hideListened);
    state.playedIds = new Set(Object.keys(res.playedTracks || {}));
    state.wantIds = new Set(Object.keys(res.wantDownloadTracks || {}));
  }

  seedDurationsFromScripts();
  applyRateAll();
  ensureFeedBar();
  ensureSidePanel();
  ensurePlaysPanel();
  ensureDebugPanel();
  applyFilters();
  debugNote("boot complete · tracks=" + getTrackItems().length);

  requestAnimationFrame(function () {
    if (dead) return;
    const count = getTrackItems().length;
    if (count) debugNote("feed ready · tracks=" + count);
    scheduleApply();
  });

  const items = getTrackItems();
  console.info(
    "[Digger] SoundCloud ready · v" +
      EXT_VERSION +
      " · tracks=" +
      items.length +
      " · bar=" +
      Boolean(document.getElementById(BAR_ID))
  );
  if (window.DiggerClientLog) window.DiggerClientLog.install("soundcloud");
  if (window.DiggerOnboarding) window.DiggerOnboarding.show("soundcloud");
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
    if (
      message.type === "SC_FEED_ONLY_MODE_CHANGED" ||
      message.type === "SET_SC_FEED_ONLY_MODE"
    ) {
      const next =
        "scFeedOnlyMode" in message ? message.scFeedOnlyMode : message.value;
      setFeedOnlyMode(next, false);
    }
    if (message.type === "SC_MIN_PLAYS_CHANGED" || message.type === "SET_SC_MIN_PLAYS") {
      const next = "scMinPlays" in message ? message.scMinPlays : message.value;
      setMinPlays(next, false);
    }
    if (
      message.type === "SC_PLAYS_FILTER_MODE_CHANGED" ||
      message.type === "SET_SC_PLAYS_FILTER_MODE"
    ) {
      const next =
        "scPlaysFilterMode" in message ? message.scPlaysFilterMode : message.value;
      setPlaysFilterMode(next, false);
    }
    if (message.type === "SET_HIDE_LISTENED") {
      setHideListened(message.value, false);
    }
    if (message.type === "FLAGS_CHANGED") {
      if ("hideListened" in message) {
        setHideListened(message.hideListened, false);
      }
    }
    if (message.type === "CLEAR_PLAYED") {
      clearPlayedTracks();
      sendToBackground({ type: "BG_CLEAR_PLAYED" });
    }
    if (message.type === "PLAYED_SYNC") {
      if (message.action === "clear") {
        clearPlayedTracks();
      } else if (message.action === "remove" && Array.isArray(message.keys)) {
        for (let i = 0; i < message.keys.length; i++) {
          state.playedIds.delete(String(message.keys[i]));
        }
        bumpListenedRevision();
        scheduleApply();
      } else if (Array.isArray(message.keys)) {
        let added = false;
        for (let i = 0; i < message.keys.length; i++) {
          const key = String(message.keys[i] || "");
          if (key.indexOf("sc:") === 0 && !state.playedIds.has(key)) {
            state.playedIds.add(key);
            added = true;
          }
        }
        if (added) {
          bumpListenedRevision();
          scheduleApply();
        }
      }
    }
    if (message.type === "WANT_SYNC") {
      mergeWantKeys(message.keys, message.action);
    }
    if (message.type === "MATCH_PROMPT") {
      if (window.DiggerMatchModal) {
        window.DiggerMatchModal.enqueue(message.prompts || []);
      }
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
    if (area === "sync" && changes.scFeedOnlyMode) {
      setFeedOnlyMode(changes.scFeedOnlyMode.newValue || "", false);
    }
    if (area === "sync" && changes.scMinPlays) {
      setMinPlays(changes.scMinPlays.newValue || 0, false);
    }
    if (area === "sync" && changes.scPlaysFilterMode) {
      setPlaysFilterMode(changes.scPlaysFilterMode.newValue || "min", false);
    }
    if (area === "local" && changes.playbackRate) {
      setPlaybackRate(changes.playbackRate.newValue, false);
    }
    if (area === "sync" && changes.hideListened) {
      setHideListened(Boolean(changes.hideListened.newValue), false);
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

document.addEventListener("keydown", function (e) {
  if (dead) return;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== "d") return;
  if (!/soundcloud\.com/i.test(location.hostname)) return;
  e.preventDefault();
  ensureDebugPanel();
  const root = document.getElementById(DEBUG_ID);
  if (!root) return;
  root.classList.remove("is-collapsed");
  if (debugUi && debugUi.toggleBtn) {
    debugUi.toggleBtn.setAttribute("aria-expanded", "true");
  }
  copyDebugSnapshot();
}, false);

function boot() {
  if (window.DiggerListenBehavior) {
    window.DiggerListenBehavior.init().catch(function () {});
  }
  loadState();
  observeTracks();
  watchSpaNavigation();
  wireListenedTracking();
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (typeof endScRatingSession === "function") endScRatingSession("tab");
    }
  });
  window.addEventListener("pagehide", function () {
    if (typeof endScRatingSession === "function") endScRatingSession("tab");
  });
}

if (document.body) boot();
else document.addEventListener("DOMContentLoaded", boot);

