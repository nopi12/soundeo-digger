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
      const isActive = id && id === state.currentTrackId;
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
        state.hideListened && played && !isActive
      );
      item.classList.toggle(HIDDEN_BLOCKED, blocked);
    }
    collectAndApplySdRatings(items);
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

function markPlayed(trackId) {
  if (dead || !trackId) return;
  const id = String(trackId);
  if (state.currentTrackId && state.currentTrackId !== id) {
    if (typeof endSdRatingSession === "function") endSdRatingSession("switch");
  }
  const isNew = !state.playedIds.has(id);
  if (isNew) {
    state.playedIds.add(id);
    persistPlayed();
  }
  state.currentTrackId = id;
  if (typeof noteSdTrackSession === "function") {
    noteSdTrackSession(id, findTrackItem(id));
  }
  applyFilters();
  resolveSourceBpm(id);
  setTimeout(applyRateAll, 40);
  setTimeout(applyRateAll, 250);
  if (isNew) {
    const item = findTrackItem(id);
    sendToBackground({
      type: "BG_RECORD_PLAY",
      play: buildSoundeoPlayPayload(item, id)
    });
  }
}

function unmarkPlayed(trackId) {
  if (dead || !trackId) return;
  const id = String(trackId);
  if (!state.playedIds.has(id)) return;
  state.playedIds.delete(id);
  if (state.currentTrackId === id) state.currentTrackId = null;
  persistPlayed();
  applyFilters();
  const item = findTrackItem(id);
  sendToBackground({
    type: "BG_UNMARK_PLAY",
    play: {
      platform: "soundeo",
      externalId: id,
      url: getTrackUrl(item) || ""
    }
  });
}

function onPlayClick(event) {
  if (dead) return;
  const actionBtn = event.target.closest("button.action[data-track-id]");
  if (actionBtn) {
    if (isPanelTrackList(actionBtn)) {
      event.preventDefault();
      event.stopPropagation();
      togglePanelPreview(actionBtn);
      return;
    }
    stopPanelPreview();
    markPlayed(actionBtn.getAttribute("data-track-id"));
    return;
  }
  if (event.target.closest("#soundeo-digger-tempo, .sd-artist-actions, .sd-skip-btn")) return;
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

function syncPlayingTrack() {
  if (dead) return;
  const id = getPlayingTrackId();
  if (!id) return;
  const sid = String(id);
  if (sid === state.currentTrackId && state.playedIds.has(sid)) return;
  markPlayed(id);
}

function schedulePlayingTrackSync() {
  syncPlayingTrack();
  setTimeout(syncPlayingTrack, 50);
  setTimeout(syncPlayingTrack, 150);
}

function observePlayingTrack() {
  if (!document.body || dead || playObserver) return;
  playObserver = new MutationObserver(function (mutations) {
    if (dead) return;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type !== "attributes" || m.attributeName !== "class") continue;
      const el = m.target;
      if (
        el &&
        el.matches &&
        el.matches("button.action[data-track-id]") &&
        el.classList.contains("stop")
      ) {
        syncPlayingTrack();
        return;
      }
    }
  });
  playObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
    subtree: true
  });
}

async function loadState() {
  if (dead) return;
  const res = await sendToBackground({ type: "BG_GET_STATE" });
  if (dead || !res || !res.ok) return;

  state.hideDownloaded = Boolean(res.hideDownloaded);
  state.hideListened = Boolean(res.hideListened);
  state.playedIds = new Set(Object.keys(res.playedTracks || {}));
  state.wantIds = new Set(
    Object.keys(res.wantDownloadTracks || {}).filter(function (key) {
      return key.indexOf("sc:") !== 0;
    })
  );
  setWantMetaMap(res.wantDownloadMeta || {});
  state.playbackRate = clampRate(res.playbackRate);
  state.targetBpm = normalizeTargetBpm(res.targetBpm);
  state.bpmCache = res.bpmCache && typeof res.bpmCache === "object" ? res.bpmCache : {};
  state.blockedArtists = sanitizeArtistList(res.blockedArtists);
  state.favoriteArtists = sanitizeArtistList(res.favoriteArtists);
  state.randomYears = Math.max(1, Math.min(20, Number(res.randomYears) || 3));
  rebuildArtistKeys();
  await loadGenrePreferences();
  applyFilters();
  applyRateAll();
  injectTempoWidget();
  applyTargetIfPossible(false);
  console.info("[Digger] Soundeo ready · v" + EXT_VERSION);
  if (window.DiggerClientLog) window.DiggerClientLog.install("soundeo");
  if (window.DiggerOnboarding) window.DiggerOnboarding.show("soundeo");
}

try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (dead || area !== "sync") return;
    if (changes.favoriteGenres || changes.selectedFavoriteGenres) {
      applyFavoriteGenres(
        changes.favoriteGenres
          ? changes.favoriteGenres.newValue
          : state.favoriteGenres,
        changes.selectedFavoriteGenres
          ? changes.selectedFavoriteGenres.newValue
          : state.selectedFavoriteGenres
      );
    }
  });
} catch (_) {}

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
      state.currentTrackId = null;
      applyFilters();
      sendToBackground({ type: "BG_CLEAR_PLAYED" }).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    }
    if (message.type === "PLAYED_SYNC") {
      if (message.action === "clear") {
        state.playedIds.clear();
        state.currentTrackId = null;
      } else if (message.action === "remove" && Array.isArray(message.keys)) {
        for (let i = 0; i < message.keys.length; i++) {
          state.playedIds.delete(String(message.keys[i]));
        }
      } else if (Array.isArray(message.keys)) {
        for (let i = 0; i < message.keys.length; i++) {
          const key = String(message.keys[i] || "");
          if (key && key.indexOf("sc:") !== 0) state.playedIds.add(key);
        }
      }
      applyFilters();
    }
    if (message.type === "WANT_SYNC") {
      mergeWantKeys(message.keys, message.action, message.meta);
    }
    if (message.type === "MATCH_PROMPT") {
      if (window.DiggerMatchModal) {
        window.DiggerMatchModal.enqueue(message.prompts || []);
      }
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
  if (window.DiggerListenBehavior) {
    window.DiggerListenBehavior.init().catch(function () {});
  }
  loadState().then(function () {
    if (dead) return;
    const pageBpm = readPageBpm();
    if (pageBpm) {
      state.sourceBpm = pageBpm;
      applyTargetIfPossible(true);
    }
  });
  observeTracks();
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (typeof endSdRatingSession === "function") endSdRatingSession("tab");
    }
  });
  window.addEventListener("pagehide", function () {
    if (typeof endSdRatingSession === "function") endSdRatingSession("tab");
  });
}

if (document.body) boot();
else document.addEventListener("DOMContentLoaded", boot);

