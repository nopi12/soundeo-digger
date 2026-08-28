(function (global) {
  const STORAGE_KEY = "diggerListenSessions";
  const WANT_META_KEY = "wantDownloadMeta";
  const MAX_SESSIONS = 400;
  const MIN_ELAPSED_SEC = 2;
  const MIN_PROFILE = 8;
  const PROFILE_WINDOW = 300;
  const SCORE_MIN = -100;
  const SCORE_MAX = 100;
  /** Minimum σ so digger-skip clusters don't explode z-scores. */
  const MIN_SIGMA_SEC = 8;
  const ARTIST_BOOST_MAX = 35;

  let sessions = [];
  let wantMeta = {};
  let loaded = false;
  let saveTimer = null;

  function mean(values) {
    if (!values.length) return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  function stdDev(values, avg) {
    if (values.length < 2) return MIN_SIGMA_SEC;
    let varSum = 0;
    for (let i = 0; i < values.length; i++) {
      const d = values[i] - avg;
      varSum += d * d;
    }
    return Math.sqrt(varSum / values.length) || MIN_SIGMA_SEC;
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

  function clampScore(points) {
    return Math.max(
      SCORE_MIN,
      Math.min(SCORE_MAX, Math.round(Number(points) || 0))
    );
  }

  function normalizeArtist(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function priorPlayCount(key, list) {
    const id = String(key || "");
    if (!id) return 0;
    let n = 0;
    const rows = list || sessions;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].key !== id) continue;
      if ((Number(rows[i].elapsedSec) || 0) >= MIN_ELAPSED_SEC) n += 1;
    }
    return n;
  }

  function wantCountForArtist(artistNorm) {
    if (!artistNorm) return 0;
    let n = 0;
    const keys = Object.keys(wantMeta || {});
    for (let i = 0; i < keys.length; i++) {
      const row = wantMeta[keys[i]];
      if (!row) continue;
      const norm =
        row.artistNorm || normalizeArtist(row.artist || "");
      if (norm === artistNorm) n += 1;
    }
    return n;
  }

  /**
   * Soft affinity: prior strong listens + vormerken of the same artist
   * lift this track continuously (0…ARTIST_BOOST_MAX).
   */
  function artistAffinity(artist, list, excludeKey) {
    const norm = normalizeArtist(artist);
    if (!norm) {
      return { boost: 0, likedTracks: 0, wantCount: 0, avgPositive: 0 };
    }
    const bestByKey = {};
    const rows = list || sessions;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (normalizeArtist(row.artist) !== norm) continue;
      if (excludeKey && row.key === excludeKey) continue;
      const pts = Number(row.listenPoints);
      if (!Number.isFinite(pts)) continue;
      const id = String(row.key || "");
      if (!id) continue;
      if (bestByKey[id] == null || pts > bestByKey[id]) bestByKey[id] = pts;
    }
    const positives = [];
    const ids = Object.keys(bestByKey);
    for (let i = 0; i < ids.length; i++) {
      if (bestByKey[ids[i]] > 15) positives.push(bestByKey[ids[i]]);
    }
    const wantCount = wantCountForArtist(norm);
    const avgPositive = positives.length ? mean(positives) : 0;
    const fromListens =
      positives.length * 6.5 + avgPositive * 0.12;
    const fromWants = wantCount * 5;
    const boost = Math.max(
      0,
      Math.min(ARTIST_BOOST_MAX, fromListens + fromWants)
    );
    return {
      boost: boost,
      likedTracks: positives.length,
      wantCount: wantCount,
      avgPositive: Math.round(avgPositive * 10) / 10
    };
  }

  function bandFromPoints(points, z) {
    if (z != null) {
      if (z < -0.45) return "wenig";
      if (z > 0.45) return "viel";
    }
    if (points <= -25) return "wenig";
    if (points >= 25) return "viel";
    return "mittel";
  }

  /** Continuous depth around ~12s neutral pivot → roughly −48…+48. */
  function absoluteDepth(elapsedSec) {
    const elapsed = Number(elapsedSec) || 0;
    if (elapsed < MIN_ELAPSED_SEC) return null;
    const z = Math.log(Math.max(elapsed, MIN_ELAPSED_SEC) / 12) * 0.55;
    const e2 = Math.exp(2 * z);
    const tanh = (e2 - 1) / (e2 + 1);
    return 48 * tanh;
  }

  /** Continuous share-of-track bonus → 0…+28. */
  function completionBonus(elapsedSec, durationSec) {
    const dur = Number(durationSec);
    if (!(dur > 0)) return 0;
    const pct = Math.max(0, Math.min(1, (Number(elapsedSec) || 0) / dur));
    return 28 * pct * pct;
  }

  /** Continuous replay bonus → 0…+22. */
  function replayBonus(priorCount) {
    const n = Math.max(0, Number(priorCount) || 0);
    return 22 * (1 - Math.exp(-n / 1.4));
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
    const sigma = Math.max(stdDev(elapsed, avg), MIN_SIGMA_SEC);
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

  function relativeDepth(elapsedSec, spectrum) {
    if (!spectrum || !spectrum.ready) return null;
    const elapsed = Number(elapsedSec) || 0;
    const z = (elapsed - spectrum.mean) / spectrum.std;
    const p = normalCdf(z);
    const centered = 2 * p - 1;
    return {
      points: centered * 42,
      z: Math.round(z * 100) / 100,
      percentile: Math.round(p * 100)
    };
  }

  function scoreFromSpectrum(elapsedSec, spectrum, durationSec, opts) {
    const options = opts || {};
    const elapsed = Number(elapsedSec) || 0;
    if (elapsed < MIN_ELAPSED_SEC) return null;

    const abs = absoluteDepth(elapsed);
    if (abs == null) return null;
    const rel = relativeDepth(elapsed, spectrum);

    let depth;
    let z = null;
    let percentile = null;
    if (rel) {
      depth = abs * 0.62 + rel.points * 0.38;
      z = rel.z;
      percentile = rel.percentile;
    } else {
      depth = abs;
      const pivotZ = Math.log(Math.max(elapsed, MIN_ELAPSED_SEC) / 12) * 0.55;
      percentile = Math.round(normalCdf(pivotZ / 0.55) * 100);
    }

    const priorCount = Number(options.priorCount) || 0;
    const affinity =
      options.affinity ||
      artistAffinity(options.artist, options.priorSessions, options.key);

    let points =
      depth +
      completionBonus(elapsed, durationSec) +
      replayBonus(priorCount) +
      (affinity.boost || 0);

    const scored = {
      points: clampScore(points),
      z: z,
      band: "mittel",
      percentile: percentile,
      pct:
        Number(durationSec) > 0
          ? Math.round((elapsed / Number(durationSec)) * 1000) / 1000
          : null,
      priorCount: priorCount,
      artistBoost: Math.round((affinity.boost || 0) * 10) / 10,
      likedTracks: affinity.likedTracks || 0,
      wantCount: affinity.wantCount || 0
    };
    scored.band = bandFromPoints(scored.points, scored.z);
    return scored;
  }

  function listenPoints(elapsedSec, durationSec, priorSessions, opts) {
    const spectrum = computeSpectrum(
      priorSessions != null ? priorSessions : sessions
    );
    const scored = scoreFromSpectrum(elapsedSec, spectrum, durationSec, opts);
    return scored ? scored.points : null;
  }

  function refreshStoredScores() {
    let changed = false;
    for (let i = 0; i < sessions.length; i++) {
      const prior = sessions.slice(0, i);
      const scored = scoreFromSpectrum(
        sessions[i].elapsedSec,
        computeSpectrum(prior),
        sessions[i].durationSec,
        {
          priorCount: priorPlayCount(sessions[i].key, prior),
          artist: sessions[i].artist,
          key: sessions[i].key,
          priorSessions: prior
        }
      );
      if (!scored) continue;
      if (sessions[i].listenPoints !== scored.points) changed = true;
      sessions[i].listenPoints = scored.points;
      sessions[i].listenZ = scored.z;
      sessions[i].listenBand = scored.band;
      sessions[i].listenPctile = scored.percentile;
      sessions[i].artistBoost = scored.artistBoost;
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
        chrome.storage.local.get([STORAGE_KEY, WANT_META_KEY], function (data) {
          sessions = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
          wantMeta =
            data[WANT_META_KEY] && typeof data[WANT_META_KEY] === "object"
              ? data[WANT_META_KEY]
              : {};
          if (refreshStoredScores()) persistSessions();
          loaded = true;
          resolve(sessions);
        });
      } catch (_) {
        loaded = true;
        sessions = [];
        wantMeta = {};
        resolve(sessions);
      }
    });
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes[WANT_META_KEY]) return;
      const next = changes[WANT_META_KEY].newValue;
      wantMeta = next && typeof next === "object" ? next : {};
    });
  } catch (_) {}

  function finishSession(meta) {
    const elapsed = Number(meta && meta.elapsedSec) || 0;
    const durationSec =
      meta && meta.durationSec != null && Number(meta.durationSec) > 0
        ? Number(meta.durationSec)
        : null;
    if (meta && meta.downloaded) return null;
    const key = String((meta && meta.key) || "");
    const artist = String((meta && meta.artist) || "");
    const priorCount = priorPlayCount(key, sessions);
    const affinity = artistAffinity(artist, sessions, key);
    const spectrum = computeSpectrum(sessions);
    const scored = scoreFromSpectrum(elapsed, spectrum, durationSec, {
      priorCount: priorCount,
      artist: artist,
      key: key,
      priorSessions: sessions,
      affinity: affinity
    });
    if (!scored) return null;

    const pct = durationSec ? elapsed / durationSec : null;
    const record = {
      platform: String((meta && meta.platform) || ""),
      key: key,
      artist: artist,
      title: String((meta && meta.title) || ""),
      elapsedSec: Math.round(elapsed * 10) / 10,
      durationSec: durationSec ? Math.round(durationSec) : null,
      pct: pct != null ? Math.round(pct * 1000) / 1000 : null,
      listenPoints: scored.points,
      listenZ: scored.z,
      listenBand: scored.band,
      listenPctile: scored.percentile,
      priorCount: priorCount,
      artistBoost: scored.artistBoost,
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
    const pts = Number(record.listenPoints) || 0;
    const boost = Number(record.artistBoost) || 0;
    const line =
      band +
      " · " +
      (pts >= 0 ? "+" : "") +
      pts +
      (boost > 0.5 ? " (a+" + Math.round(boost) + ")" : "") +
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
          priorCount: record.priorCount,
          artistBoost: record.artistBoost,
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
          ? (pts >= 0 ? "+" : "") + Math.round(pts)
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
    artistAffinity: artistAffinity,
    getSpectrum: getSpectrum,
    getSessions: getSessions,
    getLastListenPoints: getLastListenPoints,
    getLastSession: getLastSession,
    formatProfileSummary: formatProfileSummary,
    formatRecentSummary: formatRecentSummary,
    SCORE_MIN: SCORE_MIN,
    SCORE_MAX: SCORE_MAX
  };
})(window);
