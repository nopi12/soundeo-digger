(function (global) {
  const STORAGE_KEY = "diggerListenSessions";
  const MAX_SESSIONS = 400;
  const MIN_ELAPSED_SEC = 2;
  const MIN_PROFILE = 8;
  const PROFILE_WINDOW = 300;
  const SCORE_MIN = -2;
  const SCORE_MAX = 1;
  const FULL_LISTEN_SEC = 45;

  let sessions = [];
  let loaded = false;
  let saveTimer = null;

  function mean(values) {
    if (!values.length) return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  function stdDev(values, avg) {
    if (values.length < 2) return 0.6;
    let varSum = 0;
    for (let i = 0; i < values.length; i++) {
      const d = values[i] - avg;
      varSum += d * d;
    }
    return Math.sqrt(varSum / values.length) || 0.6;
  }

  function normalCdf(z) {
    const x = Number(z) || 0;
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-0.5 * x * x);
    let p =
      d *
      t *
      (0.3193815 +
        t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (x > 0) p = 1 - p;
    return p;
  }

  function listenTargetSec(durationSec) {
    const dur = Number(durationSec);
    if (dur > 30) return Math.min(FULL_LISTEN_SEC, dur * 0.35);
    return FULL_LISTEN_SEC;
  }

  function fallbackAbsolutePoints(elapsedSec, durationSec) {
    const elapsed = Number(elapsedSec) || 0;
    if (elapsed < MIN_ELAPSED_SEC) return null;
    const target = Math.max(listenTargetSec(durationSec), MIN_ELAPSED_SEC + 6);
    const span = Math.max(target - MIN_ELAPSED_SEC, 1);
    const t = Math.min(Math.max(elapsed - MIN_ELAPSED_SEC, 0) / span, 1);
    return {
      points: Math.round((SCORE_MIN + (SCORE_MAX - SCORE_MIN) * t) * 100) / 100,
      z: null,
      band: "mittel",
      percentile: Math.round(t * 100)
    };
  }

  function elapsedSamples(list) {
    const recent = (list || []).slice(-PROFILE_WINDOW);
    const out = [];
    for (let i = 0; i < recent.length; i++) {
      const n = Number(recent[i].elapsedSec) || 0;
      if (n >= MIN_ELAPSED_SEC) out.push(n);
    }
    return out;
  }

  function computeSpectrum(list) {
    const elapsed = elapsedSamples(list);
    if (elapsed.length < MIN_PROFILE) {
      return { ready: false, sampleSize: elapsed.length };
    }
    const avg = mean(elapsed);
    const sigma = Math.max(stdDev(elapsed, avg), 0.6);
    const sorted = elapsed.slice().sort(function (a, b) {
      return a - b;
    });
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    return {
      ready: true,
      sampleSize: elapsed.length,
      mean: Math.round(avg * 100) / 100,
      std: Math.round(sigma * 100) / 100,
      median: Math.round(median * 100) / 100
    };
  }

  function bandFromZ(z) {
    if (z < -0.45) return "wenig";
    if (z > 0.45) return "viel";
    return "mittel";
  }

  function scoreFromSpectrum(elapsedSec, spectrum, durationSec) {
    const elapsed = Number(elapsedSec) || 0;
    if (elapsed < MIN_ELAPSED_SEC) return null;
    let scored = null;
    if (spectrum && spectrum.ready) {
      const z = (elapsed - spectrum.mean) / spectrum.std;
      const p = normalCdf(z);
      const centered = 2 * p - 1;
      let points = centered * 1.5;
      points = Math.max(SCORE_MIN, Math.min(SCORE_MAX, points));
      scored = {
        points: Math.round(points * 100) / 100,
        z: Math.round(z * 100) / 100,
        band: bandFromZ(z),
        percentile: Math.round(p * 100)
      };
    } else {
      scored = fallbackAbsolutePoints(elapsed, durationSec);
    }
    if (!scored) return null;
    const dur = Number(durationSec);
    if (dur > 30 && elapsed / dur >= 0.85) {
      scored.points = Math.max(scored.points, 0.85);
      if (scored.points >= 0.45) scored.band = "viel";
    } else if (elapsed >= FULL_LISTEN_SEC) {
      scored.points = Math.max(scored.points, 0.85);
      if (scored.points >= 0.45) scored.band = "viel";
    }
    scored.points = Math.max(
      SCORE_MIN,
      Math.min(SCORE_MAX, Math.round(scored.points * 100) / 100)
    );
    return scored;
  }

  function listenPoints(elapsedSec, durationSec, priorSessions) {
    const spectrum = computeSpectrum(
      priorSessions != null ? priorSessions : sessions
    );
    const scored = scoreFromSpectrum(elapsedSec, spectrum, durationSec);
    return scored ? scored.points : null;
  }

  function refreshStoredScores() {
    let changed = false;
    for (let i = 0; i < sessions.length; i++) {
      const prior = sessions.slice(0, i);
      const scored = scoreFromSpectrum(
        sessions[i].elapsedSec,
        computeSpectrum(prior),
        sessions[i].durationSec
      );
      if (!scored) continue;
      if (sessions[i].listenPoints !== scored.points) changed = true;
      sessions[i].listenPoints = scored.points;
      sessions[i].listenZ = scored.z;
      sessions[i].listenBand = scored.band;
      sessions[i].listenPctile = scored.percentile;
    }
    return changed;
  }

  function persistSessions() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: sessions.slice(-MAX_SESSIONS) });
      } catch (_) {}
    }, 350);
  }

  function init() {
    if (loaded) return Promise.resolve(sessions);
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (data) {
          sessions = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
          if (refreshStoredScores()) persistSessions();
          loaded = true;
          resolve(sessions);
        });
      } catch (_) {
        loaded = true;
        sessions = [];
        resolve(sessions);
      }
    });
  }

  function finishSession(meta) {
    const elapsed = Number(meta && meta.elapsedSec) || 0;
    const durationSec =
      meta && meta.durationSec != null && Number(meta.durationSec) > 0
        ? Number(meta.durationSec)
        : null;
    if (meta && meta.downloaded) return null;
    const spectrum = computeSpectrum(sessions);
    const scored = scoreFromSpectrum(elapsed, spectrum, durationSec);
    if (!scored) return null;

    const pct = durationSec ? elapsed / durationSec : null;
    const record = {
      platform: String((meta && meta.platform) || ""),
      key: String((meta && meta.key) || ""),
      artist: String((meta && meta.artist) || ""),
      title: String((meta && meta.title) || ""),
      elapsedSec: Math.round(elapsed * 10) / 10,
      durationSec: durationSec ? Math.round(durationSec) : null,
      pct: pct != null ? Math.round(pct * 1000) / 1000 : null,
      listenPoints: scored.points,
      listenZ: scored.z,
      listenBand: scored.band,
      listenPctile: scored.percentile,
      endReason: String((meta && meta.endReason) || "switch"),
      playbackRate:
        meta && meta.playbackRate != null ? Number(meta.playbackRate) : null,
      at: Date.now()
    };
    sessions.push(record);
    if (sessions.length > MAX_SESSIONS) {
      sessions.splice(0, sessions.length - MAX_SESSIONS);
    }
    persistSessions();
    logSession(record, spectrum);
    return {
      kind: "listen_time",
      elapsedSec: record.elapsedSec,
      durationSec: record.durationSec,
      listenPoints: scored.points
    };
  }

  function logSession(record, spectrum) {
    const title = String(record.title || record.key || "").slice(0, 60);
    const band = record.listenBand || "?";
    const line =
      band +
      " · " +
      (record.listenPoints >= 0 ? "+" : "") +
      record.listenPoints.toFixed(1) +
      " · " +
      Number(record.elapsedSec || 0).toFixed(1) +
      "s · " +
      title;
    try {
      console.info("[Digger listen]", line);
    } catch (_) {}
    if (global.DiggerClientLog && global.DiggerClientLog.report) {
      global.DiggerClientLog.report("info", line, {
        source: "listen-behavior",
        platform: record.platform || "",
        context: {
          listenPoints: record.listenPoints,
          listenBand: record.listenBand,
          listenZ: record.listenZ,
          listenPctile: record.listenPctile,
          elapsedSec: record.elapsedSec,
          spectrum: spectrum && spectrum.ready ? spectrum : null
        }
      });
    }
  }

  function getSessions(limit) {
    const n = Math.max(1, Math.min(Number(limit) || 50, MAX_SESSIONS));
    return sessions.slice(-n);
  }

  function getSpectrum() {
    return computeSpectrum(sessions);
  }

  function getLastListenPoints(key) {
    const id = String(key || "");
    if (!id) return null;
    let best = null;
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i].key !== id) continue;
      const pts = Number(sessions[i].listenPoints);
      if (!Number.isFinite(pts)) continue;
      if (best == null || pts > best) best = pts;
    }
    return best;
  }

  function getLastSession(key) {
    const id = String(key || "");
    if (!id) return null;
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (sessions[i].key === id) return sessions[i];
    }
    return null;
  }

  function formatRecentSummary(limit) {
    const recent = sessions.slice(-Math.max(1, Math.min(Number(limit) || 8, 20)));
    if (!recent.length) return "listen recent: —";
    return recent
      .map(function (s) {
        const band = s.listenBand ? s.listenBand.slice(0, 1) : "?";
        const pts = Number(s.listenPoints);
        const head = Number.isFinite(pts)
          ? (pts >= 0 ? "+" : "") + pts.toFixed(1)
          : "?";
        return band + head + "/" + Number(s.elapsedSec || 0).toFixed(1) + "s";
      })
      .join(" · ");
  }

  function formatProfileSummary() {
    const spectrum = computeSpectrum(sessions);
    if (!spectrum.ready) {
      return "listen calibrating · n=" + (spectrum.sampleSize || 0) + "/" + MIN_PROFILE;
    }
    const zack =
      spectrum.median <= 4 && spectrum.std <= 1.2
        ? "zackig"
        : spectrum.median >= 20
          ? "deep"
          : "mixed";
    return (
      "listen μ=" +
      spectrum.mean.toFixed(1) +
      "s · σ=" +
      spectrum.std.toFixed(1) +
      "s · " +
      zack +
      " · n=" +
      spectrum.sampleSize
    );
  }

  global.DiggerListenBehavior = {
    init: init,
    finishSession: finishSession,
    listenPoints: listenPoints,
    scoreFromSpectrum: scoreFromSpectrum,
    computeSpectrum: computeSpectrum,
    getSpectrum: getSpectrum,
    getSessions: getSessions,
    getLastListenPoints: getLastListenPoints,
    getLastSession: getLastSession,
    formatProfileSummary: formatProfileSummary,
    formatRecentSummary: formatRecentSummary
  };
})(window);
