/**
 * Lightweight performance debug panel for SoundCloud feed lag.
 * Avoids full-feed rescans — only shows counters from perf.js.
 */

let debugPerfRefreshTimer = null;

function debugNote(message) {
  debugLog.unshift(new Date().toISOString().slice(11, 19) + " " + message);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.length = DEBUG_LOG_MAX;
  scheduleDebugPerfRefresh();
}

function memoryLine() {
  try {
    const mem = performance.memory;
    if (!mem) return "heap: n/a";
    const used = Math.round(mem.usedJSHeapSize / 1048576);
    const total = Math.round(mem.totalJSHeapSize / 1048576);
    const limit = Math.round(mem.jsHeapSizeLimit / 1048576);
    return "heap: " + used + " / " + total + " MB (limit " + limit + ")";
  } catch (_) {
    return "heap: n/a";
  }
}

function buildPerfSnapshot() {
  const p = getPerfStats();
  const avg = avgSample(p.applySamples);
  const uptimeSec = Math.max(1, Math.round((Date.now() - p.startedAt) / 1000));
  const mutAge =
    p.mutationLastAt > 0
      ? Math.round((Date.now() - p.mutationLastAt) / 1000) + "s ago"
      : "never";
  const lines = [];

  lines.push("Digger Perf · v" + EXT_VERSION);
  lines.push("uptime " + uptimeSec + "s · feed=" + (isFeedPage() ? "yes" : "no"));
  lines.push(memoryLine());
  lines.push("");

  lines.push("[applyFilters]");
  lines.push(
    "last " +
      formatPerfMs(p.applyLastMs) +
      " · avg " +
      formatPerfMs(avg) +
      " · max " +
      formatPerfMs(p.applyMaxMs)
  );
  lines.push(
    "runs " +
      p.applyCount +
      " · total " +
      formatPerfMs(p.applyTotalMs) +
      " · " +
      (p.applyCount ? (p.applyCount / uptimeSec).toFixed(2) : "0") +
      "/s"
  );
  lines.push(
    "items " +
      p.itemsLast +
      " · processed " +
      p.processedLast +
      " · skipped " +
      p.skippedLast +
      " · wantBtns " +
      p.wantBtnLast
  );
  lines.push(
    "heavyFeed " +
      (isHeavyFeed() ? "YES (≥" + HEAVY_FEED_THRESHOLD + ")" : "no") +
      " · cachedCount " +
      getCachedFeedItemCount()
  );
  lines.push("");

  lines.push("[scheduling]");
  lines.push(
    "scheduleApply " +
      p.scheduleCount +
      " · coalesced " +
      p.scheduleCoalesced +
      " · queued " +
      (typeof applyPassQueued !== "undefined" ? applyPassQueued : "?")
  );
  lines.push(
    "mutations " +
      p.mutationCount +
      " · ignored " +
      (p.mutationIgnored || 0) +
      " · lastBatch " +
      p.mutationLastBatch +
      " · " +
      mutAge
  );
  lines.push("observerOnBody " + (p.observerOnBody ? "YES (bad)" : "no (stream)"));
  lines.push("");

  lines.push("[frames]");
  lines.push(
    "fps ~" +
      p.fps +
      " · lastFrame " +
      formatPerfMs(p.lastFrameMs) +
      " · maxFrame " +
      formatPerfMs(p.maxFrameMs)
  );
  lines.push("longFrames (>50ms) " + p.longFrames);
  lines.push("");

  lines.push("[prune/dom]");
  lines.push(
    "pruneRuns " +
      p.pruneRuns +
      " · removed " +
      p.pruneRemoved +
      " · durationCache " +
      durationByUrl.size
  );
  lines.push(
    "played " +
      state.playedIds.size +
      " · want " +
      state.wantIds.size +
      " · hideListened " +
      state.hideListened
  );
  if (window.DiggerListenBehavior) {
    lines.push(window.DiggerListenBehavior.formatProfileSummary());
    lines.push(window.DiggerListenBehavior.formatRecentSummary(12));
  }
  lines.push("");

  lines.push("[hints]");
  if (p.applyLastMs > 50 || p.applyMaxMs > 80) {
    lines.push("! applyFilters zu langsam — DOM-Arbeit pro Pass reduzieren");
  }
  if (p.observerOnBody) {
    lines.push("! MutationObserver auf document.body — zu viele Callbacks");
  }
  if (p.mutationCount > 200 && uptimeSec < 60) {
    const ignored = p.mutationIgnored || 0;
    const useful = p.mutationCount - ignored;
    if (useful > 100) {
      lines.push("! sehr viele relevante Mutations — scheduleApply feuert zu oft");
    } else {
      lines.push("· viele Mutations, aber meist ignoriert (Echo/Filter OK)");
    }
  }
  if (p.itemsLast > HEAVY_FEED_THRESHOLD) {
    lines.push("! Feed zu groß — Prune/Debounce prüfen");
  }
  if (p.fps && p.fps < 40) {
    lines.push("! FPS niedrig — Main-Thread blockiert");
  }
  if (p.processedLast > 80 && p.skippedLast < p.processedLast) {
    lines.push("! wenig Skip-Cache — Items werden ständig neu verarbeitet");
  }
  if (
    p.applyLastMs <= 50 &&
    !p.observerOnBody &&
    p.fps >= 40 &&
    p.itemsLast <= HEAVY_FEED_THRESHOLD
  ) {
    lines.push("· aktuell keine klaren Perf-Alarme");
  }

  if (debugLog.length) {
    lines.push("");
    lines.push("[events]");
    for (let i = 0; i < Math.min(6, debugLog.length); i++) {
      lines.push("- " + debugLog[i]);
    }
  }

  return lines.join("\n");
}

function scheduleDebugPerfRefresh() {
  if (debugPerfRefreshTimer || dead) return;
  debugPerfRefreshTimer = setTimeout(function () {
    debugPerfRefreshTimer = null;
    updateDebugPanel();
  }, 500);
}

async function copyDebugSnapshot() {
  const text = buildPerfSnapshot();
  if (debugUi && debugUi.textarea) debugUi.textarea.value = text;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      if (debugUi && debugUi.copyBtn) {
        const prev = debugUi.copyBtn.textContent;
        debugUi.copyBtn.textContent = "Kopiert!";
        setTimeout(function () {
          if (debugUi && debugUi.copyBtn) debugUi.copyBtn.textContent = prev;
        }, 1200);
      }
      return true;
    }
  } catch (_) {}
  if (debugUi && debugUi.textarea) {
    debugUi.textarea.focus();
    debugUi.textarea.select();
    try {
      document.execCommand("copy");
      return true;
    } catch (_) {}
  }
  return false;
}

function updateDebugPanel() {
  if (!debugUi || !debugUi.textarea) return;
  if (debugUi.root && debugUi.root.classList.contains("is-collapsed")) return;
  debugUi.textarea.value = buildPerfSnapshot();
}

function bindDebugPanel(root) {
  debugUi = {
    root: root,
    body: root.querySelector(".digger-sc-debug-body"),
    textarea: root.querySelector(".digger-sc-debug-text"),
    copyBtn: root.querySelector(".digger-sc-debug-copy"),
    refreshBtn: root.querySelector(".digger-sc-debug-refresh"),
    toggleBtn: root.querySelector(".digger-sc-debug-toggle")
  };

  if (debugUi.toggleBtn && debugUi.body) {
    debugUi.toggleBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const collapsed = root.classList.toggle("is-collapsed");
      debugUi.toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (!collapsed) updateDebugPanel();
    });
  }

  if (debugUi.copyBtn) {
    debugUi.copyBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      copyDebugSnapshot();
    });
  }

  if (debugUi.refreshBtn) {
    debugUi.refreshBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      updateDebugPanel();
    });
  }

  wireIsolation(root);
  updateDebugPanel();
  startPerfMonitors();
}

function injectDebugPanel() {
  if (dead) return;
  const existing = document.getElementById(DEBUG_ID);
  if (existing) {
    if (!debugUi || debugUi.root !== existing) bindDebugPanel(existing);
    return;
  }

  const root = document.createElement("div");
  root.id = DEBUG_ID;
  root.className = "digger-sc-debug-panel";

  const header = document.createElement("div");
  header.className = "digger-sc-debug-header";

  const title = document.createElement("div");
  title.className = "digger-sc-debug-title";
  title.textContent = "Perf";

  const actions = document.createElement("div");
  actions.className = "digger-sc-debug-actions";

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "digger-sc-debug-refresh";
  refreshBtn.textContent = "↻";
  refreshBtn.title = "Refresh";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "digger-sc-debug-copy";
  copyBtn.textContent = "Copy";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "digger-sc-debug-toggle";
  toggleBtn.textContent = "▾";
  toggleBtn.setAttribute("aria-expanded", "true");

  actions.appendChild(refreshBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(toggleBtn);
  header.appendChild(title);
  header.appendChild(actions);

  const body = document.createElement("div");
  body.className = "digger-sc-debug-body";
  const textarea = document.createElement("textarea");
  textarea.className = "digger-sc-debug-text";
  textarea.readOnly = true;
  textarea.spellcheck = false;
  body.appendChild(textarea);

  root.appendChild(header);
  root.appendChild(body);
  document.body.appendChild(root);
  bindDebugPanel(root);
}

function ensureDebugPanel() {
  if (dead) return;
  injectDebugPanel();
}
