(() => {
  if (window.__soundeoDiggerRateHook) return;
  window.__soundeoDiggerRateHook = true;

  const ATTR = "data-soundeo-digger-rate";

  function readRate() {
    const n = Number(document.documentElement.getAttribute(ATTR));
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
      if (m.type === "attributes" && m.attributeName === ATTR) {
        applyAll();
        return;
      }
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTR]
  });
})();
