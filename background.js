const PLAYED_STORAGE_KEY = "playedTracks";
const PLAYED_SCHEMA_KEY = "playedTracksSchema";
const PLAYED_SCHEMA_VERSION = 2;
const PLAYBACK_RATE_KEY = "playbackRate";
const TARGET_BPM_KEY = "targetBpm";
const BPM_CACHE_KEY = "bpmCache";
const BLOCKED_ARTISTS_KEY = "blockedArtists";
const FAVORITE_ARTISTS_KEY = "favoriteArtists";
const DEFAULT_TARGET_BPM = 120;
const BPM_SLIDER_MIN = 80;
const BPM_SLIDER_MAX = 160;

function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.2, Math.max(0.8, n));
}

function clampSourceBpm(bpm) {
  const n = Number(bpm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(300, Math.max(50, Math.round(n)));
}

function clampTargetBpm(bpm) {
  const n = Number(bpm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(BPM_SLIDER_MAX, Math.max(BPM_SLIDER_MIN, Math.round(n)));
}

function normalizeTargetBpm(bpm) {
  return clampTargetBpm(bpm) || DEFAULT_TARGET_BPM;
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

async function getPlayed() {
  const data = await chrome.storage.local.get([
    PLAYED_STORAGE_KEY,
    PLAYED_SCHEMA_KEY
  ]);
  const schema = Number(data[PLAYED_SCHEMA_KEY]) || 0;
  if (schema < PLAYED_SCHEMA_VERSION) {
    await chrome.storage.local.set({
      [PLAYED_STORAGE_KEY]: {},
      [PLAYED_SCHEMA_KEY]: PLAYED_SCHEMA_VERSION
    });
    return {};
  }
  return data[PLAYED_STORAGE_KEY] || {};
}

async function setPlayed(playedObj) {
  await chrome.storage.local.set({
    [PLAYED_STORAGE_KEY]: playedObj || {},
    [PLAYED_SCHEMA_KEY]: PLAYED_SCHEMA_VERSION
  });
}

async function getPlaybackRate() {
  const data = await chrome.storage.local.get([PLAYBACK_RATE_KEY]);
  return clampRate(data[PLAYBACK_RATE_KEY]);
}

async function getTargetBpm() {
  const data = await chrome.storage.local.get([TARGET_BPM_KEY]);
  return normalizeTargetBpm(data[TARGET_BPM_KEY]);
}

async function getBpmCache() {
  const data = await chrome.storage.local.get([BPM_CACHE_KEY]);
  return data[BPM_CACHE_KEY] || {};
}

async function getArtistLists() {
  const data = await chrome.storage.sync.get([
    BLOCKED_ARTISTS_KEY,
    FAVORITE_ARTISTS_KEY
  ]);
  return {
    blockedArtists: sanitizeArtistList(data[BLOCKED_ARTISTS_KEY]),
    favoriteArtists: sanitizeArtistList(data[FAVORITE_ARTISTS_KEY])
  };
}

function broadcastToSoundeoTabs(payload) {
  chrome.tabs.query({ url: "https://soundeo.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, payload, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "BG_GET_STATE") {
    Promise.all([
      chrome.storage.sync.get(["hideDownloaded", "hideListened", "randomYears"]),
      getPlayed(),
      getPlaybackRate(),
      getTargetBpm(),
      getBpmCache(),
      getArtistLists()
    ])
      .then(([sync, played, playbackRate, targetBpm, bpmCache, artists]) => {
        sendResponse({
          ok: true,
          hideDownloaded: Boolean(sync.hideDownloaded),
          hideListened: Boolean(sync.hideListened),
          playedTracks: played,
          playbackRate,
          targetBpm,
          bpmCache,
          blockedArtists: artists.blockedArtists,
          favoriteArtists: artists.favoriteArtists,
          randomYears: Math.max(1, Math.min(20, Number(sync.randomYears) || 3))
        });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "BG_SET_PLAYED") {
    setPlayed(message.playedTracks || {})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "BG_CLEAR_PLAYED") {
    setPlayed({})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "BG_SET_PLAYBACK_RATE") {
    const playbackRate = clampRate(message.playbackRate);
    chrome.storage.local
      .set({ [PLAYBACK_RATE_KEY]: playbackRate })
      .then(() => {
        broadcastToSoundeoTabs({ type: "RATE_CHANGED", playbackRate });
        sendResponse({ ok: true, playbackRate });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "BG_SET_TARGET_BPM") {
    const targetBpm = normalizeTargetBpm(message.targetBpm);
    chrome.storage.local
      .set({ [TARGET_BPM_KEY]: targetBpm })
      .then(() => {
        broadcastToSoundeoTabs({ type: "TARGET_BPM_CHANGED", targetBpm });
        sendResponse({ ok: true, targetBpm });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "BG_CACHE_BPM") {
    const trackId = String(message.trackId || "");
    const bpm = clampSourceBpm(message.bpm);
    if (!trackId || !bpm) {
      sendResponse({ ok: false });
      return true;
    }
    getBpmCache()
      .then((cache) => {
        cache[trackId] = bpm;
        return chrome.storage.local.set({ [BPM_CACHE_KEY]: cache });
      })
      .then(() => sendResponse({ ok: true, bpm }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "BG_SET_ARTISTS") {
    const blockedArtists = sanitizeArtistList(message.blockedArtists);
    const favoriteArtists = sanitizeArtistList(message.favoriteArtists);
    chrome.storage.sync
      .set({
        [BLOCKED_ARTISTS_KEY]: blockedArtists,
        [FAVORITE_ARTISTS_KEY]: favoriteArtists
      })
      .then(() => {
        broadcastToSoundeoTabs({
          type: "ARTISTS_CHANGED",
          blockedArtists,
          favoriteArtists
        });
        sendResponse({ ok: true, blockedArtists, favoriteArtists });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "BG_SET_FLAGS") {
    const patch = {};
    if ("hideDownloaded" in message) {
      patch.hideDownloaded = Boolean(message.hideDownloaded);
    }
    if ("hideListened" in message) {
      patch.hideListened = Boolean(message.hideListened);
    }
    chrome.storage.sync
      .set(patch)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes.hideDownloaded || changes.hideListened) {
      const payload = { type: "FLAGS_CHANGED" };
      if (changes.hideDownloaded) {
        payload.hideDownloaded = Boolean(changes.hideDownloaded.newValue);
      }
      if (changes.hideListened) {
        payload.hideListened = Boolean(changes.hideListened.newValue);
      }
      broadcastToSoundeoTabs(payload);
    }

    if (changes[BLOCKED_ARTISTS_KEY] || changes[FAVORITE_ARTISTS_KEY]) {
      const payload = { type: "ARTISTS_CHANGED" };
      if (changes[BLOCKED_ARTISTS_KEY]) {
        payload.blockedArtists = sanitizeArtistList(
          changes[BLOCKED_ARTISTS_KEY].newValue
        );
      }
      if (changes[FAVORITE_ARTISTS_KEY]) {
        payload.favoriteArtists = sanitizeArtistList(
          changes[FAVORITE_ARTISTS_KEY].newValue
        );
      }
      broadcastToSoundeoTabs(payload);
    }
  }

  if (area === "local") {
    if (changes[PLAYBACK_RATE_KEY]) {
      broadcastToSoundeoTabs({
        type: "RATE_CHANGED",
        playbackRate: clampRate(changes[PLAYBACK_RATE_KEY].newValue)
      });
    }
    if (changes[TARGET_BPM_KEY]) {
      broadcastToSoundeoTabs({
        type: "TARGET_BPM_CHANGED",
        targetBpm: normalizeTargetBpm(changes[TARGET_BPM_KEY].newValue)
      });
    }
  }
});
