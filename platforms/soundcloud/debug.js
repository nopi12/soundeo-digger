function formatDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  return m + ":" + String(s).padStart(2, "0");
}

function buildFirstTracksDurationLog(items) {
  const lines = [];
  const limit = Math.min(5, items.length);

  lines.push("[first " + limit + " tracks · duration]");
  if (!limit) {
    lines.push("(keine Feed-Items)");
    lines.push("");
    return lines;
  }

  for (let i = 0; i < limit; i++) {
    const item = items[i];
    const title = getItemTitle(item) || "(no title)";
    const resolved = resolveFilterDuration(item);
    const seconds = resolved.seconds;
    const probe = probeDurationSource(item);
    const freshProbe =
      probe.source === "data-attr" ? probeDurationSource(item, true) : probe;
    const kind =
      seconds == null ? "?" : seconds > SET_MAX_SECONDS ? "set" : "track";
    lines.push(
      (i + 1) +
        ". " +
        formatDurationLabel(seconds) +
        " (" +
        (seconds != null ? seconds + "s" : "?") +
        ") · " +
        kind +
        " · src=" +
        resolved.source +
        (freshProbe.source !== probe.source ? " / fresh=" + freshProbe.source : "") +
        " · " +
        title.slice(0, 70)
    );
  }
  lines.push("");
  return lines;
}

function countDuplicateIds(id) {
  try {
    return document.querySelectorAll("#" + CSS.escape(id)).length;
  } catch (_) {
    return document.querySelectorAll('[id="' + id + '"]').length;
  }
}

function isElementVisible(el) {
  if (!el) return false;
  try {
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  } catch (_) {
    return false;
  }
}

function analyzeHideToggleDiagnostics(items) {
  const lines = [];
  const warnings = [];
  const panelEl = document.getElementById(PANEL_ID);
  const feedOk = isFeedPage();
  let wiredCount = 0;
  let optionCount = 0;

  if (panelEl) {
    const options = panelEl.querySelectorAll(".digger-sc-panel-option");
    optionCount = options.length;
    options.forEach(function (option, index) {
      const wired = option.dataset.diggerEventsWired === "2";
      if (wired) wiredCount += 1;
      const radio = option.querySelector('input[type="radio"]');
      lines.push(
        "option[" +
          index +
          "]: wired=" +
          wired +
          " id=" +
          (radio && radio.id ? radio.id : "?") +
          " domChecked=" +
          (radio ? radio.checked : "?") +
          " connected=" +
          (radio ? radio.isConnected : "?") +
          " form=" +
          (radio && radio.getAttribute("form") ? radio.getAttribute("form") : "-")
      );
      if (!wired) warnings.push("Option " + index + " hat keine Event-Listener (diggerEventsWired fehlt)");
      if (radio && !radio.isConnected) warnings.push("Radio " + (radio.id || index) + " nicht im DOM");
    });
  }

  const stateDomMismatch =
    panelUi &&
    panelUi.setsRadio &&
    (panelUi.setsRadio.checked !== (state.feedOnlyMode === FEED_ONLY_MODES.SETS) ||
      panelUi.tracksRadio.checked !== (state.feedOnlyMode === FEED_ONLY_MODES.TRACKS) ||
      panelUi.freeDownloadsRadio.checked !==
        (state.feedOnlyMode === FEED_ONLY_MODES.FREE_DOWNLOADS));

  if (!feedOk) {
    warnings.push("Nicht auf /feed – Schalter wirken hier nicht (nur Titel-Suche in Bar)");
  }
  if (!panelEl) {
    warnings.push("Panel fehlt im DOM");
  } else if (!isElementVisible(panelEl)) {
    warnings.push("Panel ist per CSS ausgeblendet (z. B. Viewport < 1180px)");
  }
  if (!panelUi) {
    warnings.push("panelUi ist null – Panel evtl. nicht gebunden");
  }
  if (stateDomMismatch) {
    warnings.push(
      "State/DOM-Mismatch: state=" +
        JSON.stringify(state.feedOnlyMode) +
        " dom={sets:" +
        (panelUi && panelUi.setsRadio ? panelUi.setsRadio.checked : "?") +
        ",tracks:" +
        (panelUi && panelUi.tracksRadio ? panelUi.tracksRadio.checked : "?") +
        ",freeDl:" +
        (panelUi && panelUi.freeDownloadsRadio ? panelUi.freeDownloadsRadio.checked : "?") +
        "}"
    );
  }
  if (optionCount && wiredCount < optionCount) {
    warnings.push("Nur " + wiredCount + "/" + optionCount + " Optionen haben Click-Handler");
  }

  Object.keys(FIELD_IDS).forEach(function (key) {
    const count = countDuplicateIds(FIELD_IDS[key]);
    if (count > 1) {
      warnings.push("Duplicate id " + FIELD_IDS[key] + " (" + count + "x im DOM)");
    }
  });
  if (countDuplicateIds(PANEL_ID) > 1) {
    warnings.push("Duplicate panel id (" + countDuplicateIds(PANEL_ID) + "x)");
  }

  let withDuration = 0;
  let setsCandidates = 0;
  let tracksCandidates = 0;
  let freeDlCandidates = 0;
  let hiddenByOnlyMode = 0;
  let hiddenTotal = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = getItemTitle(item);
    const seconds = readFilterDurationSeconds(item);
    const isHidden = item.classList.contains(HIDDEN_CLASS);
    if (seconds != null) withDuration += 1;
    if (seconds != null && seconds > SET_MAX_SECONDS) setsCandidates += 1;
    if (seconds != null && seconds <= SET_MAX_SECONDS) tracksCandidates += 1;
    if (isFreeDownloadTitle(title)) freeDlCandidates += 1;
    if (isHidden) hiddenTotal += 1;
    if (state.feedOnlyMode && !matchesFeedOnlyMode(item, title)) hiddenByOnlyMode += 1;
  }

  lines.push("");
  lines.push("[filter effect]");
  lines.push("tracksWithDuration: " + withDuration + "/" + items.length);
  lines.push("setsCandidates (>20min): " + setsCandidates);
  lines.push("tracksCandidates (<=20min): " + tracksCandidates);
  lines.push("freeDlCandidates (title match): " + freeDlCandidates);
  lines.push(
    "wouldHideNow: onlyMode=" +
      hiddenByOnlyMode +
      " totalHidden=" +
      hiddenTotal +
      " mode=" +
      JSON.stringify(state.feedOnlyMode)
  );

  if (state.feedOnlyMode === FEED_ONLY_MODES.SETS && setsCandidates === 0) {
    warnings.push(
      "Nur DJ-Sets aktiv, aber 0 Sets >20min gefunden – Dauer-Erkennung liefert nichts (nur " +
        withDuration +
        "/" +
        items.length +
        " mit Dauer)"
    );
  }
  if (state.feedOnlyMode === FEED_ONLY_MODES.TRACKS && tracksCandidates === 0) {
    warnings.push(
      "Nur Einzeltracks aktiv, aber 0 Tracks <=20min gefunden – Dauer-Erkennung evtl. kaputt"
    );
  }
  if (state.feedOnlyMode === FEED_ONLY_MODES.FREE_DOWNLOADS && freeDlCandidates === 0) {
    warnings.push("Nur Free Downloads aktiv, aber kein passender Titel im Feed");
  }
  if (state.feedOnlyMode && hiddenTotal === 0 && items.length > 0) {
    warnings.push("Only-Filter aktiv, aber 0 Tracks werden aktuell ausgeblendet");
  }
  if (dead) warnings.push("Extension ist retired/dead");
  if (applying) warnings.push("applyFilters läuft gerade (applying=true)");
  if (sidePanelInjecting) warnings.push("Panel wird gerade neu injiziert");

  return { lines: lines, warnings: warnings, wiredCount: wiredCount, optionCount: optionCount };
}

function probeDurationSource(item, skipCache) {
  if (!item) return { seconds: null, source: "none" };

  if (!skipCache) {
    const cached = Number(item.getAttribute(DURATION_ATTR));
    const src = item.getAttribute(DURATION_SRC_ATTR) || "data-attr";
    if (Number.isFinite(cached) && cached > 0) {
      return { seconds: cached, source: src };
    }
  }

  const resolved = resolveFilterDuration(item);
  return { seconds: resolved.seconds, source: resolved.source };
}

function buildVisibilityReport(items) {
  const lines = [];
  const titleFilter = sanitizeTitleFilter(state.titleFilter);
  let hiddenByTitle = 0;
  let hiddenByOnlyMode = 0;
  let visible = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = getItemTitle(item);
    const hideByTitle = titleFilter && title ? !titleMatches(title, titleFilter) : false;
    const hideByOnly = state.feedOnlyMode ? !matchesFeedOnlyMode(item, title) : false;
    const hide = hideByTitle || hideByOnly;
    if (hideByTitle) hiddenByTitle += 1;
    if (hideByOnly) hiddenByOnlyMode += 1;
    if (!hide) visible += 1;
  }

  lines.push("[visibility]");
  lines.push("visible now: " + visible + "/" + items.length);
  if (titleFilter) {
    lines.push(
      'titleFilter "' +
        titleFilter +
        '": hides ' +
        hiddenByTitle +
        "/" +
        items.length +
        " (Substring im Titel)"
    );
  } else {
    lines.push("titleFilter: off");
  }
  if (state.feedOnlyMode) {
    lines.push(
      "feedOnlyMode " +
        JSON.stringify(state.feedOnlyMode) +
        ": hides " +
        hiddenByOnlyMode +
        "/" +
        items.length
    );
  } else {
    lines.push("feedOnlyMode: off");
  }
  if (titleFilter && state.feedOnlyMode && visible === 0 && items.length > 0) {
    lines.push(
      "! Beide Filter aktiv – Ergebnis ist Schnittmenge. Leerer Feed kann am Titel-Filter liegen, nicht an DJ-Sets."
    );
  } else if (titleFilter && hiddenByTitle === items.length && items.length > 0) {
    lines.push("! Titel-Filter blendet aktuell alle Items aus – Feed wirkt leer.");
  }
  lines.push("");
  return lines;
}

function buildDjSetsReport(items) {
  const lines = [];
  const sourceCounts = {
    none: 0,
    "data-attr": 0,
    "hydration-cache": 0,
    "dom-selector": 0,
    "scan-fallback": 0
  };
  const freshSourceCounts = {
    none: 0,
    "hydration-cache": 0,
    "dom-selector": 0,
    "scan-fallback": 0
  };
  let withDuration = 0;
  let setsCandidates = 0;
  let tracksCandidates = 0;
  let visibleWithSetsFilter = 0;
  let hiddenWithSetsFilter = 0;
  let hiddenBecauseNoDuration = 0;
  const setsActive = state.feedOnlyMode === FEED_ONLY_MODES.SETS;
  const pct = function (part, total) {
    if (!total) return "0%";
    return Math.round((part / total) * 100) + "%";
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = getItemTitle(item);
    const probe = probeDurationSource(item);
    const freshProbe = probe.source === "data-attr" ? probeDurationSource(item, true) : probe;
    const seconds = probe.seconds;
    sourceCounts[probe.source] = (sourceCounts[probe.source] || 0) + 1;
    if (freshProbe.source !== "data-attr") {
      freshSourceCounts[freshProbe.source] = (freshSourceCounts[freshProbe.source] || 0) + 1;
    }

    if (seconds != null) {
      withDuration += 1;
      if (seconds > SET_MAX_SECONDS) setsCandidates += 1;
      else tracksCandidates += 1;
    }

    if (setsActive) {
      const wouldShow = matchesFeedOnlyMode(item, title);
      if (wouldShow) visibleWithSetsFilter += 1;
      else {
        hiddenWithSetsFilter += 1;
        if (seconds == null) hiddenBecauseNoDuration += 1;
      }
    }
  }

  lines.push("[dj-sets report]");
  lines.push("filter active: " + (setsActive ? "yes (Nur DJ-Sets)" : "no"));
  lines.push("threshold: >20 min (" + SET_MAX_SECONDS + " s)");
  lines.push("feed items: " + items.length);
  lines.push(
    "duration known: " +
      withDuration +
      "/" +
      items.length +
      " (" +
      pct(withDuration, items.length) +
      ")"
  );
  lines.push("  >20 min (would count as set): " + setsCandidates);
  lines.push("  <=20 min (Einzeltrack): " + tracksCandidates);
  lines.push(
    "  unknown duration: " +
      (items.length - withDuration) +
      " (" +
      pct(items.length - withDuration, items.length) +
      ")"
  );
  lines.push("duration cache (URLs): " + durationByUrl.size);
  lines.push("duration sources in feed (stored on item):");
  lines.push("  cached on item: " + (sourceCounts["data-attr"] || 0));
  lines.push("  hydration/API cache: " + (sourceCounts["hydration-cache"] || 0));
  lines.push("  DOM selectors: " + (sourceCounts["dom-selector"] || 0));
  lines.push("  text scan fallback: " + (sourceCounts["scan-fallback"] || 0));
  lines.push("  none detected: " + (sourceCounts.none || 0));
  if (sourceCounts["data-attr"] > 0) {
    lines.push("fresh probe (without item cache):");
    lines.push("  hydration/API cache: " + (freshSourceCounts["hydration-cache"] || 0));
    lines.push("  DOM selectors: " + (freshSourceCounts["dom-selector"] || 0));
    lines.push("  text scan fallback: " + (freshSourceCounts["scan-fallback"] || 0));
    lines.push("  none detected: " + (freshSourceCounts.none || 0));
  }

  if (!setsActive && setsCandidates > 0) {
    lines.push(
      "simulation: Nur DJ-Sets würde " + setsCandidates + "/" + items.length + " Items zeigen."
    );
  }

  if (setsActive) {
    lines.push(
      "with filter on: visible=" +
        visibleWithSetsFilter +
        " hidden=" +
        hiddenWithSetsFilter +
        " (of those hidden, " +
        hiddenBecauseNoDuration +
        " because duration=null)"
    );
  }

  lines.push("");
  lines.push("verdict:");
  if (!isFeedPage()) {
    lines.push("  Filter gilt nur auf /feed – hier wirkungslos.");
  } else if (!items.length) {
    lines.push("  Keine Feed-Items im DOM – nichts zum Filtern.");
  } else if (withDuration === 0) {
    lines.push(
      "  KAPUTT – 0/" +
        items.length +
        " Dauern erkannt. Feed wirkt leer oder unverändert."
    );
  } else if (setsCandidates === 0) {
    lines.push(
      "  FILTER LEER – Dauer wird gelesen, aber kein Track >20 min im aktuellen Feed."
    );
  } else if (setsActive && visibleWithSetsFilter === 0) {
    lines.push(
      "  KAPUTT – Sets im Feed, aber nichts sichtbar (Logik- oder Cache-Mismatch)."
    );
  } else if (items.length - withDuration > items.length * 0.5) {
    lines.push(
      "  TEILWEISE – über die Hälfte ohne Dauer; echte DJ-Sets darunter fehlen im Ergebnis."
    );
  } else if (setsActive) {
    lines.push("  OK – Sets erkannt und Filter blendet Einzeltracks aus.");
  } else if (setsCandidates > 0) {
    lines.push(
      "  BEREIT – " +
        setsCandidates +
        " Sets erkannt; Filter aus. Aktivieren sollte funktionieren."
    );
  } else {
    lines.push("  BEREIT – Dauer-Erkennung läuft; Filter derzeit aus.");
  }

  const needsDjSetsHelp =
    withDuration === 0 ||
    (setsActive && visibleWithSetsFilter === 0 && setsCandidates > 0) ||
    (setsActive && setsCandidates === 0) ||
    items.length - withDuration > items.length * 0.5;

  if (needsDjSetsHelp) {
    lines.push("");
    lines.push("warum Nur DJ-Sets hier problematisch ist:");
    if (withDuration === 0) {
      lines.push("  – Keine Laufzeit erkannt; SoundCloud-Feed zeigt Dauer oft nicht im DOM.");
      lines.push("  – Hydration/fetch-Hook (page-hook.js) liefert nichts für sichtbare URLs.");
    } else if (setsActive && setsCandidates === 0) {
      lines.push("  – Dauer wird gelesen, aber kein Track >20 min im aktuellen Feed.");
    } else if (setsActive && visibleWithSetsFilter === 0 && setsCandidates > 0) {
      lines.push("  – Sets im Feed, aber Filter zeigt nichts (Logik- oder Anzeige-Bug).");
    } else if (items.length - withDuration > items.length * 0.5) {
      lines.push("  – Über die Hälfte ohne Dauer; echte Sets darunter fehlen im Ergebnis.");
    }
    lines.push(
      "  – Ohne Dauer → matchesFeedOnlyMode=false → Item wird ausgeblendet (nicht „unbekannt“)."
    );
    lines.push(
      "  – Klassifikation nur über >20 min, nicht über Tags/Titel/Playlist-Typ."
    );
  }

  return lines;
}

function buildDebugSnapshot() {
  const lines = [];
  const items = isFeedPage() ? getTrackItems() : [];
  const toggleDiag = analyzeHideToggleDiagnostics(items);

  lines.push("Digger SoundCloud Debug · v" + EXT_VERSION);
  lines.push("Time: " + new Date().toISOString());
  lines.push("URL: " + location.href);
  lines.push("Feed page: " + (isFeedPage() ? "yes" : "no"));
  lines.push("");
  lines.push("[state]");
  lines.push("titleFilter: " + JSON.stringify(state.titleFilter));
  lines.push("feedOnlyMode: " + JSON.stringify(state.feedOnlyMode));
  lines.push("playbackRate: " + state.playbackRate);
  lines.push("dead: " + dead + " applying: " + applying + " sidePanelInjecting: " + sidePanelInjecting);
  lines.push("");
  lines.push("[ui]");
  lines.push("bar: " + (document.getElementById(BAR_ID) ? "mounted" : "missing"));
  lines.push("panel: " + (document.getElementById(PANEL_ID) ? "mounted" : "missing"));
  lines.push(
    "panel visible: " +
      (document.getElementById(PANEL_ID) ? isElementVisible(document.getElementById(PANEL_ID)) : false)
  );
  lines.push(
    "panel wired: " +
      (document.getElementById(PANEL_ID)
        ? document.getElementById(PANEL_ID).dataset.wired || "?"
        : "-")
  );
  lines.push("panelUi: " + (panelUi ? "bound" : "null"));
  lines.push("barUi: " + (barUi ? "bound" : "null"));
  lines.push(
    "events wired: " + toggleDiag.wiredCount + "/" + toggleDiag.optionCount + " options"
  );
  if (panelUi && panelUi.setsRadio) {
    lines.push(
      "radio dom: sets=" +
        panelUi.setsRadio.checked +
        " tracks=" +
        (panelUi.tracksRadio ? panelUi.tracksRadio.checked : "?") +
        " freeDl=" +
        (panelUi.freeDownloadsRadio ? panelUi.freeDownloadsRadio.checked : "?")
    );
  }
  lines.push("duration cache: " + durationByUrl.size);
  lines.push("");
  lines.push("[hide-toggle diagnostics]");
  toggleDiag.lines.forEach(function (line) {
    lines.push(line);
  });
  lines.push("");
  if (toggleDiag.warnings.length) {
    lines.push("[warnings]");
    toggleDiag.warnings.forEach(function (warning) {
      lines.push("! " + warning);
    });
    lines.push("");
  } else {
    lines.push("[warnings]");
    lines.push("(keine – Schalter sollten grundsätzlich funktionieren)");
    lines.push("");
  }
  if (debugLog.length) {
    lines.push("[recent events]");
    debugLog.forEach(function (entry) {
      lines.push("- " + entry);
    });
    lines.push("");
  } else {
    lines.push("[recent events]");
    lines.push("(noch keine – bitte Schalter einmal klicken und ↻ drücken)");
    lines.push("");
  }
  buildVisibilityReport(items).forEach(function (line) {
    lines.push(line);
  });
  buildFirstTracksDurationLog(items).forEach(function (line) {
    lines.push(line);
  });
  buildDjSetsReport(items).forEach(function (line) {
    lines.push(line);
  });
  return lines.join("\n");
}

async function copyDebugSnapshot() {
  const text = buildDebugSnapshot();
  if (debugUi && debugUi.textarea) {
    debugUi.textarea.value = text;
  }
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
  debugUi.textarea.value = buildDebugSnapshot();
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

  if (debugUi.textarea) {
    debugUi.textarea.addEventListener("click", function (e) {
      e.stopPropagation();
      debugUi.textarea.focus();
      debugUi.textarea.select();
    });
    debugUi.textarea.addEventListener("focus", function () {
      debugUi.textarea.select();
    });
  }

  wireIsolation(root);
  updateDebugPanel();
}

function injectDebugPanel() {
  const root = document.createElement("aside");
  root.id = DEBUG_ID;
  root.className = "digger-sc-debug-panel";
  root.dataset.wired = "debug1";

  const header = document.createElement("div");
  header.className = "digger-sc-debug-header";

  const title = document.createElement("span");
  title.className = "digger-sc-debug-title";
  title.textContent = "Debug";
  title.title = "Ctrl+Shift+D = Copy Snapshot";

  const actions = document.createElement("div");
  actions.className = "digger-sc-debug-actions";

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "digger-sc-debug-refresh";
  refreshBtn.textContent = "↻";
  refreshBtn.title = "Aktualisieren";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "digger-sc-debug-copy";
  copyBtn.textContent = "Copy";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "digger-sc-debug-toggle";
  toggleBtn.textContent = "▾";
  toggleBtn.title = "Ein-/Ausklappen";
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
  textarea.setAttribute("aria-label", "Digger Debug Snapshot");

  body.appendChild(textarea);
  root.appendChild(header);
  root.appendChild(body);
  document.body.appendChild(root);

  bindDebugPanel(root);
}

function ensureDebugPanel() {
  if (dead) return;
  const existing = document.getElementById(DEBUG_ID);
  if (existing) {
    if (!debugUi || existing.dataset.wired !== "debug1") {
      bindDebugPanel(existing);
    } else {
      updateDebugPanel();
    }
    return;
  }
  injectDebugPanel();
}
