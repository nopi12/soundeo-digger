(() => {
  if (window.__diggerRateHook) return;
  window.__diggerRateHook = true;

  const ATTR = "data-digger-rate";
  const LEGACY_ATTR = "data-soundeo-digger-rate";

  function readRate() {
    const raw =
      document.documentElement.getAttribute(ATTR) ||
      document.documentElement.getAttribute(LEGACY_ATTR);
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1.2, Math.max(0.8, n));
  }

  function apply(el) {
    if (!el || typeof el.playbackRate !== "number") return;
    const next = readRate();
    try {
      // Ableton-style re-pitch: pitch follows tempo (vinyl/tape)
      if ("preservesPitch" in el) el.preservesPitch = false;
      if ("mozPreservesPitch" in el) el.mozPreservesPitch = false;
      if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = false;
      if (Math.abs(el.playbackRate - next) > 0.001) el.playbackRate = next;
    } catch (_) {}
  }

  function applyAll() {
    try {
      document.querySelectorAll("audio, video").forEach(apply);
    } catch (_) {}
  }

  try {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      apply(this);
      const result = orig.apply(this, args);
      if (result && typeof result.then === "function") {
        result.then(() => apply(this)).catch(() => {});
      }
      return result;
    };
  } catch (_) {}

  document.addEventListener("play", (e) => apply(e.target), true);

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (
        m.type === "attributes" &&
        (m.attributeName === ATTR || m.attributeName === LEGACY_ATTR)
      ) {
        applyAll();
        return;
      }
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTR, LEGACY_ATTR]
  });

  if (!/soundcloud\.com$/i.test(location.hostname)) return;

  const SC_EVENT = "digger:sc-duration-data";

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      const path = parsed.pathname.replace(/\/+$/, "");
      return path || "/";
    } catch (_) {
      return null;
    }
  }

  function collectTrackDurations(value, out, seen, depth) {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) collectTrackDurations(item, out, seen, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    if (typeof value.permalink_url === "string" && Number.isFinite(Number(value.duration))) {
      const url = normalizeUrl(value.permalink_url);
      const durationMs = Number(value.duration);
      if (url && durationMs > 0 && !seen.has(url)) {
        seen.add(url);
        out.push({ url, durationMs });
      }
    }

    const keys = [
      "data",
      "collection",
      "tracks",
      "track",
      "playlist",
      "items",
      "sounds",
      "sound"
    ];
    for (const key of keys) {
      if (key in value) collectTrackDurations(value[key], out, seen, depth + 1);
    }
  }

  function emitTrackDurations(payload) {
    const tracks = [];
    collectTrackDurations(payload, tracks, new Set(), 0);
    if (!tracks.length) return;
    window.dispatchEvent(
      new CustomEvent(SC_EVENT, {
        detail: { tracks }
      })
    );
  }

  function inspectFetchResponse(url, res) {
    if (!url || !/soundcloud\.com|sndcdn\.com/i.test(url)) return;
    const contentType = String(res.headers.get("content-type") || "");
    if (!/json/i.test(contentType)) return;
    res
      .clone()
      .json()
      .then(emitTrackDurations)
      .catch(() => {});
  }

  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          inspectFetchResponse(res.url || String(args[0] || ""), res);
        } catch (_) {}
        return res;
      });
    };
  } catch (_) {}
})();
