const PLAYED_ATTR = "data-digger-sc-played";
const LISTENED_REV_ATTR = "data-digger-sc-listened-rev";
const SC_PLAYED_PREFIX = "sc:";
const SC_RESERVED_PATHS = new Set([
  "discover",
  "stream",
  "you",
  "pages",
  "settings",
  "signin",
  "search",
  "feed",
  "charts",
  "stations",
  "messages",
  "notifications",
  "likes",
  "following",
  "followers",
  "albums",
  "sets",
  "tracks",
  "reposts",
  "comments"
]);

let listenedRevision = 0;
let playedSaveTimer = null;
let playObserver = null;

function getListenedRevision() {
  return listenedRevision;
}

function bumpListenedRevision() {
  listenedRevision++;
}

function playedKey(url) {
  if (!url) return null;
  return SC_PLAYED_PREFIX + url;
}

function isTrackPath(path) {
  const parts = String(path || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) return false;
  return !SC_RESERVED_PATHS.has(parts[0].toLowerCase());
}

function artistFromTrackUrl(url) {
  const path = String(url || "").replace(/^\/+/, "");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return "";
  return decodeURIComponent(parts[0]).replace(/-/g, " ");
}

function buildScPlayPayload(url, item) {
  const path = normalizeTrackUrl(url) || url;
  const title = item ? getItemTitle(item) : "";
  const artist = artistFromTrackUrl(path);
  let durationSec = null;
  if (item && typeof readFilterDurationSeconds === "function") {
    durationSec = readFilterDurationSeconds(item);
  } else if (path && durationByUrl.has(path)) {
    durationSec = durationByUrl.get(path);
  }
  return {
    platform: "soundcloud",
    externalId: path,
    rawTitle: artist && title ? artist + " - " + title : title || artist,
    artist: artist,
    title: title,
    url: path ? "https://soundcloud.com" + path : "",
    durationSec: durationSec,
    bpm: null,
    label: "",
    musicalKey: ""
  };
}

function persistPlayed() {
  if (dead) return;
  clearTimeout(playedSaveTimer);
  playedSaveTimer = setTimeout(function () {
    if (dead) return;
    const obj = {};
    state.playedIds.forEach(function (id) {
      obj[id] = true;
    });
    sendToBackground({ type: "BG_SET_PLAYED", playedTracks: obj });
  }, 250);
}

function markPlayed(url, item) {
  if (dead || !url) return;
  const key = playedKey(url);
  if (!key) return;
  if (state.currentTrackUrl && state.currentTrackUrl !== key) {
    if (typeof endScRatingSession === "function") endScRatingSession("switch");
  }
  const isNew = !state.playedIds.has(key);
  if (isNew) {
    state.playedIds.add(key);
    persistPlayed();
    sendToBackground({
      type: "BG_RECORD_PLAY",
      play: buildScPlayPayload(url, item || null)
    });
  }
  state.currentTrackUrl = key;
  if (typeof noteScTrackSession === "function") {
    noteScTrackSession(url, item || null);
  }
  bumpListenedRevision();
  scheduleApply();
}

function unmarkPlayed(url) {
  if (dead || !url) return;
  const key = playedKey(url);
  if (!key || !state.playedIds.has(key)) return;
  state.playedIds.delete(key);
  if (state.currentTrackUrl === key) state.currentTrackUrl = null;
  persistPlayed();
  bumpListenedRevision();
  scheduleApply();
  sendToBackground({
    type: "BG_UNMARK_PLAY",
    play: buildScPlayPayload(url, null)
  });
}

function isItemPlayed(item) {
  const key = playedKey(getTrackUrl(item));
  return key ? state.playedIds.has(key) : false;
}

function isItemActive(item) {
  const key = playedKey(getTrackUrl(item));
  return Boolean(key && key === state.currentTrackUrl);
}

function shouldHideListenedItem(item) {
  return state.hideListened && isItemPlayed(item) && !isItemActive(item);
}

function applyListenedMarkers(item) {
  if (!item) return;
  if (isItemPlayed(item)) item.setAttribute(PLAYED_ATTR, "");
  else item.removeAttribute(PLAYED_ATTR);
}

function getPlayingTrackUrl() {
  let playingItem;
  try {
    playingItem = document.querySelector(
      "li.soundList__item.playing, li.soundList__item.is-playing, li[class*='soundList__item'][class*='playing']"
    );
  } catch (_) {
    playingItem = null;
  }
  if (playingItem) {
    const url = getTrackUrl(playingItem);
    if (url) return url;
  }

  let playerLink;
  try {
    playerLink =
      document.querySelector("[class*='playback'] a[href^='/']") ||
      document.querySelector("[class*='playControls'] a[href^='/']") ||
      document.querySelector("div[class*='soundPlayer'] a[href^='/']");
  } catch (_) {
    playerLink = null;
  }
  if (playerLink) {
    try {
      const href = playerLink.getAttribute("href") || playerLink.href;
      const normalized = normalizeTrackUrl(new URL(href, location.origin).href);
      if (normalized && isTrackPath(normalized)) return normalized;
    } catch (_) {}
  }

  const pagePath = normalizeTrackUrl(location.pathname);
  if (pagePath && isTrackPath(pagePath)) return pagePath;
  return null;
}

function syncPlayingTrack() {
  if (dead) return;
  const url = getPlayingTrackUrl();
  if (!url) {
    if (typeof endScRatingSession === "function") endScRatingSession("stop");
    return;
  }
  const key = playedKey(url);
  if (key === state.currentTrackUrl && state.playedIds.has(key)) return;
  markPlayed(url);
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
      if (!el || !el.matches) continue;
      if (
        el.matches("li.soundList__item, li[class*='soundList__item']") &&
        (el.classList.contains("playing") || el.classList.contains("is-playing"))
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

function retireListened() {
  clearTimeout(playedSaveTimer);
  playedSaveTimer = null;
  if (playObserver) {
    try {
      playObserver.disconnect();
    } catch (_) {}
    playObserver = null;
  }
}

function setHideListened(value, persist) {
  state.hideListened = Boolean(value);
  bumpListenedRevision();
  scheduleApply();
  if (persist === false || dead) return;
  sendToBackground({ type: "BG_SET_FLAGS", hideListened: state.hideListened });
}

function clearPlayedTracks() {
  state.playedIds.clear();
  state.currentTrackUrl = null;
  bumpListenedRevision();
  scheduleApply();
}

function onPlayClick(event) {
  if (dead) return;
  if (event.target.closest("#" + BAR_ID + ", #" + PANEL_ID + ", #" + PLAYS_PANEL_ID + ", #" + DEBUG_ID)) {
    return;
  }
  const item = resolveTrackRoot(event.target);
  if (!item) return;
  const playTarget = event.target.closest(
    "button[class*='play'], [class*='playButton'], .sound__playButton, .sound__waveform, [class*='waveform'], .sound__playbackControls, [class*='playbackControls']"
  );
  if (!playTarget) return;
  const url = getTrackUrl(item);
  if (url) markPlayed(url, item);
}

function onManualToggle(event) {
  if (dead || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
  const item = resolveTrackRoot(event.target);
  if (!item) return;
  if (event.target.closest("#" + BAR_ID + ", #" + PANEL_ID + ", #" + PLAYS_PANEL_ID + ", #" + DEBUG_ID)) {
    return;
  }
  if (event.target.closest("a, button")) return;
  event.preventDefault();
  event.stopPropagation();
  const url = getTrackUrl(item);
  if (!url) return;
  const key = playedKey(url);
  if (key && state.playedIds.has(key)) unmarkPlayed(url);
  else markPlayed(url, item);
}

function onAudioPlay() {
  schedulePlayingTrackSync();
}

function wireListenedTracking() {
  document.addEventListener("click", onPlayClick, true);
  document.addEventListener("click", onManualToggle, true);
  document.addEventListener("play", onAudioPlay, true);
  observePlayingTrack();
}
