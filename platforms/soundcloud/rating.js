const SCORE_ITEM_CLASS = "digger-sc-score-item";
const SCORE_CLASS = "digger-sc-score";

let ratingLookupTimer = null;
let ratingLookupInFlight = false;
const ratingLookupPending = new Set();

function sendRatingSignal(signal, play) {
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
  const key = localKeyFromPlayLike(play);
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

function localKeyFromPlayLike(play) {
  if (!play) return null;
  if (play.platform === "soundcloud") {
    const id = String(play.externalId || "");
    return id ? (id.indexOf("sc:") === 0 ? id : "sc:" + id) : null;
  }
  return play.externalId ? String(play.externalId) : null;
}

function itemRatingKey(item) {
  const url = getTrackUrl(item);
  return url ? playedKey(url) : null;
}

function resolveScRating(item, key) {
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
  return window.DiggerRating.defaultRating(key);
}

function findScoreHost(item) {
  if (!item) return null;
  return (
    item.querySelector("ul.soundStats") ||
    item.querySelector(".soundStats") ||
    item.querySelector("[class*='soundStats']") ||
    item.querySelector("ul[class*='ministats']") ||
    item.querySelector(".sound__soundStats") ||
    item.querySelector("[class*='soundTitle__stats']")
  );
}

function removeRatingBadge(item) {
  if (!item) return;
  const el = item.querySelector("." + SCORE_ITEM_CLASS);
  if (el) {
    try {
      el.remove();
    } catch (_) {}
  }
}

function applyRatingBadge(item) {
  if (!item || !window.DiggerRating) return;
  const key = itemRatingKey(item);
  if (!key) {
    removeRatingBadge(item);
    return;
  }
  const rating = resolveScRating(item, key);
  const host = findScoreHost(item);
  if (!host) return;

  let wrap = item.querySelector("." + SCORE_ITEM_CLASS);
  if (!wrap) {
    wrap = document.createElement(host.tagName === "UL" ? "li" : "span");
    wrap.className =
      SCORE_ITEM_CLASS + (host.tagName === "UL" ? " sc-ministats-item" : "");
    const inner = document.createElement("span");
    inner.className = SCORE_CLASS;
    wrap.appendChild(inner);
  }
  if (wrap.parentNode !== host) host.appendChild(wrap);

  const inner = wrap.querySelector("." + SCORE_CLASS) || wrap;
  const nextValue = window.DiggerRating.formatScore(rating.score);
  const nextTitle = window.DiggerRating.scoreTitle(rating);
  const valueEl = inner.querySelector(".digger-sc-score-value");
  if (valueEl && valueEl.textContent === nextValue && wrap.title === nextTitle) {
    return;
  }
  inner.innerHTML =
    window.DiggerRating.starSvg +
    '<span class="digger-sc-score-value">' +
    nextValue +
    "</span>";
  wrap.title = nextTitle;
  wrap.setAttribute("aria-label", nextTitle);
}

function needsRatingSync(item) {
  if (!item || !window.DiggerRating) return false;
  const key = itemRatingKey(item);
  if (!key) return false;
  const rating = resolveScRating(item, key);
  const badge = item.querySelector("." + SCORE_ITEM_CLASS);
  if (!badge) return true;
  const valueEl = badge.querySelector(".digger-sc-score-value");
  return (
    !valueEl ||
    valueEl.textContent !== window.DiggerRating.formatScore(rating.score)
  );
}

function queueRatingLookup(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (!key) continue;
    const stored = state.ratingsByKey[key];
    if (stored && stored.signal) continue;
    if (Object.prototype.hasOwnProperty.call(state.ratingsByKey, key)) continue;
    ratingLookupPending.add(key);
  }
  if (!ratingLookupPending.size) return;
  clearTimeout(ratingLookupTimer);
  ratingLookupTimer = setTimeout(flushRatingLookup, 280);
}

function flushRatingLookup() {
  if (ratingLookupInFlight || dead) return;
  const keys = [];
  ratingLookupPending.forEach(function (key) {
    if (keys.length < 80) keys.push(key);
  });
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i++) ratingLookupPending.delete(keys[i]);
  ratingLookupInFlight = true;
  sendToBackground({ type: "BG_LOOKUP_RATINGS", keys: keys }).then(function (res) {
    ratingLookupInFlight = false;
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
    if (ratingLookupPending.size) {
      clearTimeout(ratingLookupTimer);
      ratingLookupTimer = setTimeout(flushRatingLookup, 200);
    }
  });
}

function collectAndApplyRatings(items) {
  const keys = [];
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    applyRatingBadge(items[i]);
    const key = itemRatingKey(items[i]);
    if (key) keys.push(key);
  }
  queueRatingLookup(keys);
}

function noteScTrackSession(url, item) {
  if (!window.DiggerRating || !url) return;
  const key = playedKey(url);
  const payload = buildScPlayPayload(url, item || null);
  window.DiggerRating.noteSession(
    {
      key: key,
      platform: "soundcloud",
      artist: payload.artist || "",
      title: payload.title || "",
      durationSec: payload && payload.durationSec,
      playbackRate: state.playbackRate,
      payload: payload,
      downloaded: false
    },
    sendRatingSignal
  );
}

function endScRatingSession(reason) {
  if (window.DiggerRating) {
    window.DiggerRating.endSession(sendRatingSignal, reason || "stop");
  }
}
