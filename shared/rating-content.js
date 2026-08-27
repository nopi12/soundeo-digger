(function (global) {
  const SCORE_STAR_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M8 1.35l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 10.35l-3.52 1.84.67-3.92L2.3 5.49l3.94-.57L8 1.35z"/>' +
    "</svg>";

  let session = null;

  function startSession(info) {
    if (!info || !info.key) return;
    session = {
      key: String(info.key),
      platform: String(info.platform || ""),
      artist: String(info.artist || ""),
      title: String(info.title || ""),
      startedAt: Date.now(),
      durationSec: Number(info.durationSec) || null,
      payload: info.payload || null,
      downloaded: Boolean(info.downloaded),
      playbackRate:
        info.playbackRate != null ? Number(info.playbackRate) : null
    };
  }

  function currentSession() {
    return session;
  }

  function markSessionDownloaded() {
    if (session) session.downloaded = true;
  }

  function endSession(sendFn, endReason) {
    if (!session) return null;
    const prev = session;
    session = null;
    const elapsed = (Date.now() - prev.startedAt) / 1000;
    let signal = null;
    if (global.DiggerListenBehavior) {
      signal = global.DiggerListenBehavior.finishSession({
        platform: prev.platform || "",
        key: prev.key,
        artist: prev.artist || "",
        title: prev.title || "",
        elapsedSec: elapsed,
        durationSec: prev.durationSec,
        downloaded: prev.downloaded,
        endReason: endReason || "switch",
        playbackRate: prev.playbackRate
      });
    }
    if (signal && typeof sendFn === "function" && prev.payload) {
      sendFn(signal, prev.payload);
    }
    return signal
      ? Object.assign({ key: prev.key, elapsed: elapsed }, signal)
      : null;
  }

  function noteSession(info, sendFn) {
    if (!info || !info.key) return;
    if (session && session.key === info.key) return;
    endSession(sendFn, "switch");
    startSession(info);
  }

  function formatScore(value) {
    const n = Math.round(Number(value) || 0);
    return String(n);
  }

  function scoreTitle(rating) {
    if (!rating) return "Digger 0";
    const parts = ["Digger " + formatScore(rating.score)];
    if (rating.elapsedSec) parts.push(Math.round(Number(rating.elapsedSec)) + "s gehört");
    if (rating.downloads) parts.push(rating.downloads + " gekauft");
    if (rating.listens) parts.push(rating.listens + " positiv");
    if (rating.skips) parts.push(rating.skips + " negativ");
    if (
      !rating.downloads &&
      !rating.listens &&
      !rating.skips &&
      !rating.elapsedSec
    ) {
      parts.push("noch keine Bewertungen");
    }
    return parts.join(" · ");
  }

  function defaultRating(key) {
    return {
      score: 0,
      users: 0,
      skips: 0,
      listens: 0,
      downloads: 0,
      keys: key ? [String(key)] : [],
      signal: ""
    };
  }

  function buildFromListenPoints(points, key, elapsedSec) {
    const score = Math.round(Number(points) || 0);
    return {
      score: score,
      users: 1,
      listens: score > 0 ? 1 : 0,
      skips: score < 0 ? 1 : 0,
      downloads: 0,
      keys: key ? [String(key)] : [],
      signal: "listen_time",
      listenPoints: Number(points) || 0,
      elapsedSec: elapsedSec != null ? Number(elapsedSec) : null
    };
  }

  function buildFromSignal(kind, key) {
    if (kind === "download") {
      return {
        score: 5,
        users: 1,
        downloads: 1,
        listens: 0,
        skips: 0,
        keys: key ? [String(key)] : [],
        signal: "download"
      };
    }
    return defaultRating(key);
  }

  function resolveRating(map, key) {
    if (!key) return null;
    const rating = map && map[key];
    if (rating && typeof rating === "object") return rating;
    return defaultRating(key);
  }

  function setListenRating(map, key, points, elapsedSec) {
    if (!map || !key || points == null) return null;
    map[key] = buildFromListenPoints(points, key, elapsedSec);
    return map[key];
  }

  function setSignalRating(map, key, kind) {
    if (!map || !key || !kind) return null;
    map[key] = buildFromSignal(kind, key);
    return map[key];
  }

  function mergeRatingMap(target, incoming) {
    if (!target || !incoming || typeof incoming !== "object") return target;
    const keys = Object.keys(incoming);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const row = incoming[key];
      if (!row) continue;
      target[key] = row;
      if (Array.isArray(row.keys)) {
        for (let k = 0; k < row.keys.length; k++) {
          const alias = String(row.keys[k] || "");
          if (alias) target[alias] = row;
        }
      }
    }
    return target;
  }

  global.DiggerRating = {
    starSvg: SCORE_STAR_SVG,
    startSession: startSession,
    currentSession: currentSession,
    markSessionDownloaded: markSessionDownloaded,
    endSession: endSession,
    noteSession: noteSession,
    formatScore: formatScore,
    scoreTitle: scoreTitle,
    defaultRating: defaultRating,
    buildFromListenPoints: buildFromListenPoints,
    buildFromSignal: buildFromSignal,
    resolveRating: resolveRating,
    setListenRating: setListenRating,
    setSignalRating: setSignalRating,
    mergeRatingMap: mergeRatingMap
  };
})(window);
