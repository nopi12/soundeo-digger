/**
 * Content-script helper: forward errors/warns to background → server.
 */
(function (root) {
  function detectPlatform() {
    try {
      const host = location.hostname || "";
      if (host.indexOf("soundcloud") >= 0) return "soundcloud";
      if (host.indexOf("soundeo") >= 0) return "soundeo";
    } catch (_) {}
    return "";
  }

  function extVersion() {
    try {
      if (typeof getExtVersion === "function") return getExtVersion();
      if (typeof EXT_VERSION !== "undefined" && EXT_VERSION) return String(EXT_VERSION);
      if (chrome.runtime && chrome.runtime.getManifest) {
        return String(chrome.runtime.getManifest().version || "0");
      }
    } catch (_) {}
    return "0";
  }

  function sendLog(entry) {
    try {
      chrome.runtime.sendMessage(
        { type: "BG_CLIENT_LOG", log: entry },
        function () {
          void chrome.runtime.lastError;
        }
      );
    } catch (_) {}
  }

  function report(level, message, extras) {
    const extra = extras || {};
    sendLog({
      level: level,
      message: String(message || "").slice(0, 1000),
      source: extra.source || "content",
      platform: extra.platform || detectPlatform(),
      stack: extra.stack ? String(extra.stack).slice(0, 4000) : "",
      url: extra.url || (typeof location !== "undefined" ? location.href : ""),
      extVersion: extra.extVersion || extVersion(),
      context: extra.context || null,
      ts: Date.now() / 1000
    });
  }

  function installGlobalHandlers(platform) {
    const plat = platform || detectPlatform();
    try {
      window.addEventListener("error", function (event) {
        report("error", (event && event.message) || "content error", {
          source: "content:error",
          platform: plat,
          stack: event && event.error && event.error.stack ? event.error.stack : "",
          context: {
            filename: event && event.filename ? String(event.filename) : "",
            lineno: event && event.lineno != null ? event.lineno : null
          }
        });
      });
    } catch (_) {}
    try {
      window.addEventListener("unhandledrejection", function (event) {
        const reason = event && event.reason;
        report(
          "error",
          reason && reason.message ? reason.message : String(reason || "rejection"),
          {
            source: "content:unhandledrejection",
            platform: plat,
            stack: reason && reason.stack ? String(reason.stack) : ""
          }
        );
      });
    } catch (_) {}
  }

  root.DiggerClientLog = {
    report: report,
    error: function (message, extras) {
      report("error", message, extras);
    },
    warn: function (message, extras) {
      report("warn", message, extras);
    },
    install: installGlobalHandlers
  };
})(typeof window !== "undefined" ? window : self);
