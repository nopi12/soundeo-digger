const SD_SCORE_CLASS = "sd-digger-score";

let sdRatingLookupTimer = null;
let sdRatingLookupInFlight = false;
const sdRatingLookupPending = new Set();

function sendSdRatingSignal(signal, play) {
  if (!signal || !play) return;
  const row =
    typeof signal === "string"
      ? { kind: signal }
      : Object.assign({}, signal);
  if (!row.kind) return;
  sendToBackground({
    type: "BG_RECORD_SIGNAL",
    kind: row.kind,
    play: play,
    elapsedSec: row.elapsedSec,
    durationSec: row.durationSec,
    listenPoints: row.listenPoints
  });
  const key = play.externalId ? String(play.externalId) : null;
  if (!key || !window.DiggerRating) return;
  if (row.kind === "download") {
    window.DiggerRating.setSignalRating(state.ratingsByKey, key, "download");
  } else if (row.listenPoints != null) {
    window.DiggerRating.setListenRating(
      state.ratingsByKey,
      key,
      row.listenPoints,
      row.elapsedSec
    );
  }
  scheduleApply();
}

function resolveSdRating(item, key) {
  if (!key || !window.DiggerRating) return null;
  const stored = state.ratingsByKey[key];
  if (stored && stored.signal) return stored;
  if (window.DiggerListenBehavior) {
    const pts = window.DiggerListenBehavior.getLastListenPoints(key);
    const last = window.DiggerListenBehavior.getLastSession(key);
    if (pts != null) {
      return window.DiggerRating.buildFromListenPoints(
        pts,
        key,
        last && last.elapsedSec
      );
    }
  }
  if (item && isDownloaded(item)) {
    return window.DiggerRating.buildFromSignal("download", key);
  }
  return window.DiggerRating.resolveRating(state.ratingsByKey, key);
}

function sdItemRatingKey(item) {
  if (!item) return null;
  const id = item.getAttribute("data-track-id");
  return id ? String(id) : null;
}

function findSdScoreHost(item) {
  if (!item) return null;
  return (
    item.querySelector(":scope > .vote") ||
    item.querySelector(".vote") ||
    item.querySelector(".info") ||
    item
  );
}

function removeSdRatingBadge(item) {
  if (!item) return;
  const el = item.querySelector(":scope > ." + SD_SCORE_CLASS) || item.querySelector("." + SD_SCORE_CLASS);
  if (el) {
    try {
      el.remove();
    } catch (_) {}
  }
}

function applySdRatingBadge(item) {
  if (!item || !window.DiggerRating) return;
  const key = sdItemRatingKey(item);
  if (!key) {
    removeSdRatingBadge(item);
    return;
  }
  const rating = resolveSdRating(item, key);

  let el = null;
  try {
    el = item.querySelector(":scope > ." + SD_SCORE_CLASS);
  } catch (_) {
    el = item.querySelector("." + SD_SCORE_CLASS);
  }
  if (!el) {
    el = document.createElement("span");
    el.className = SD_SCORE_CLASS;
  }

  const vote = item.querySelector(":scope > .vote") || item.querySelector(".vote");
  if (vote && vote.parentNode === item) {
    const afterVote = vote.nextSibling;
    if (el.parentNode !== item || vote.nextElementSibling !== el) {
      if (afterVote) item.insertBefore(el, afterVote);
      else item.appendChild(el);
    }
  } else if (!el.parentNode) {
    const host = findSdScoreHost(item);
    if (host && host !== item) host.appendChild(el);
    else item.appendChild(el);
  }

  const nextValue = window.DiggerRating.formatScore(rating.score);
  const nextTitle = window.DiggerRating.scoreTitle(rating);
  const valueEl = el.querySelector(".sd-digger-score-value");
  if (valueEl && valueEl.textContent === nextValue && el.title === nextTitle) {
    return;
  }
  el.innerHTML =
    window.DiggerRating.starSvg +
    '<span class="sd-digger-score-value">' +
    nextValue +
    "</span>";
  el.title = nextTitle;
  el.setAttribute("aria-label", nextTitle);
}

function queueSdRatingLookup(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (!key) continue;
    const stored = state.ratingsByKey[key];
    if (stored && stored.signal) continue;
    if (Object.prototype.hasOwnProperty.call(state.ratingsByKey, key)) continue;
    sdRatingLookupPending.add(key);
  }
  if (!sdRatingLookupPending.size) return;
  clearTimeout(sdRatingLookupTimer);
  sdRatingLookupTimer = setTimeout(flushSdRatingLookup, 280);
}

function flushSdRatingLookup() {
  if (sdRatingLookupInFlight || dead) return;
  const keys = [];
  sdRatingLookupPending.forEach(function (key) {
    if (keys.length < 80) keys.push(key);
  });
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i++) sdRatingLookupPending.delete(keys[i]);
  sdRatingLookupInFlight = true;
  sendToBackground({ type: "BG_LOOKUP_RATINGS", keys: keys }).then(function (res) {
    sdRatingLookupInFlight = false;
    if (dead) return;
    if (res && res.ok && res.ratings && window.DiggerRating) {
      window.DiggerRating.mergeRatingMap(state.ratingsByKey, res.ratings);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (state.ratingsByKey[key] && state.ratingsByKey[key].signal) continue;
        if (!Object.prototype.hasOwnProperty.call(state.ratingsByKey, key)) {
          state.ratingsByKey[key] = { score: 0, users: 0, signal: "" };
        }
      }
      scheduleApply();
    }
    if (sdRatingLookupPending.size) {
      clearTimeout(sdRatingLookupTimer);
      sdRatingLookupTimer = setTimeout(flushSdRatingLookup, 200);
    }
  });
}

function collectAndApplySdRatings(items) {
  const keys = [];
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    applySdRatingBadge(items[i]);
    const key = sdItemRatingKey(items[i]);
    if (key) keys.push(key);
  }
  queueSdRatingLookup(keys);
}

function noteSdTrackSession(trackId, item) {
  if (!window.DiggerRating || !trackId) return;
  const id = String(trackId);
  const row = item || findTrackItem(id);
  const payload = buildSoundeoPlayPayload(row, id);
  window.DiggerRating.noteSession(
    {
      key: id,
      platform: "soundeo",
      artist: payload.artist || "",
      title: payload.title || "",
      durationSec: payload && payload.durationSec,
      playbackRate: state.playbackRate,
      payload: payload,
      downloaded: isDownloaded(row)
    },
    sendSdRatingSignal
  );
}

function endSdRatingSession(reason) {
  if (window.DiggerRating) {
    window.DiggerRating.endSession(sendSdRatingSignal, reason || "stop");
  }
}

function recordSdDownload(item) {
  if (!item || dead) return;
  const id = sdItemRatingKey(item);
  if (!id) return;
  if (window.DiggerRating) window.DiggerRating.markSessionDownloaded();
  sendSdRatingSignal("download", buildSoundeoPlayPayload(item, id));
}
