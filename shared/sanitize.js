/**
 * Shared sanitizers / clamps for popup, background, and content scripts.
 * MV3: load before dependents (manifest order / importScripts).
 */
(function (root) {
  const RATE_MIN = 0.8;
  const RATE_MAX = 1.2;

  function getExtVersion() {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) {
        const v = chrome.runtime.getManifest().version;
        if (v) return String(v);
      }
    } catch (_) {}
    return "0";
  }

  function clampRate(rate) {
    const n = Number(rate);
    if (!Number.isFinite(n)) return 1;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, n));
  }

  function sanitizeTitleFilter(value) {
    return String(value || "").trim().slice(0, 120);
  }

  function sanitizeFeedOnlyMode(value) {
    const mode = String(value || "").trim();
    if (mode === "sets" || mode === "tracks" || mode === "freeDownloads") return mode;
    return "";
  }

  function sanitizeMinPlays(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 999999999);
  }

  function sanitizePlaysFilterMode(value) {
    const mode = String(value || "").trim();
    if (mode === "max") return "max";
    return "min";
  }

  function sanitizeMatchMinScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(0.95, Math.round(n * 100) / 100);
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

  root.DiggerSanitize = {
    RATE_MIN: RATE_MIN,
    RATE_MAX: RATE_MAX,
    getExtVersion: getExtVersion,
    clampRate: clampRate,
    sanitizeTitleFilter: sanitizeTitleFilter,
    sanitizeFeedOnlyMode: sanitizeFeedOnlyMode,
    sanitizeMinPlays: sanitizeMinPlays,
    sanitizePlaysFilterMode: sanitizePlaysFilterMode,
    sanitizeMatchMinScore: sanitizeMatchMinScore,
    normalizeArtistKey: normalizeArtistKey,
    sanitizeArtistList: sanitizeArtistList
  };

  // Global aliases for content scripts / SW that call functions by name.
  root.clampRate = clampRate;
  root.sanitizeTitleFilter = sanitizeTitleFilter;
  root.sanitizeFeedOnlyMode = sanitizeFeedOnlyMode;
  root.sanitizeMinPlays = sanitizeMinPlays;
  root.sanitizePlaysFilterMode = sanitizePlaysFilterMode;
  root.sanitizeMatchMinScore = sanitizeMatchMinScore;
  root.normalizeArtistKey = normalizeArtistKey;
  root.sanitizeArtistList = sanitizeArtistList;
  root.getExtVersion = getExtVersion;
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : window);
