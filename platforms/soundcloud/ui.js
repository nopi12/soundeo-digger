function wireIsolation(root) {
  if (!root || root.dataset.overlayIso === "1") return;
  root.dataset.overlayIso = "1";
  const stop = function (e) {
    e.stopPropagation();
  };
  root.addEventListener("mousedown", stop, false);
  root.addEventListener("pointerdown", stop, false);
  root.addEventListener("click", stop, false);
  root.addEventListener("keydown", stop, false);
}

function updateBarUi() {
  const offset = rateToOffset(state.playbackRate);
  try {
    if (barUi && barUi.slider && String(barUi.slider.value) !== String(offset)) {
      barUi.slider.value = String(offset);
    }
    if (barUi && barUi.rateLabel) barUi.rateLabel.textContent = formatOffset(offset);
    if (barUi && barUi.filterInput && barUi.filterInput.value !== state.titleFilter) {
      barUi.filterInput.value = state.titleFilter;
    }
    if (barUi && barUi.hideListenedInput) {
      barUi.hideListenedInput.checked = state.hideListened;
    }
    if (panelUi && panelUi.setsRadio) {
      syncPanelOnlyRadios();
    }
    if (panelUi && panelUi.scopeHint) {
      panelUi.scopeHint.textContent = isFeedPage()
        ? "Gilt nur auf der Feed-Seite"
        : "Auf der Feed-Seite verfügbar";
    }
    if (playsPanelUi && playsPanelUi.minPlaysInput) {
      const nextValue = state.minPlays > 0 ? String(state.minPlays) : "";
      if (playsPanelUi.minPlaysInput.value !== nextValue) {
        playsPanelUi.minPlaysInput.value = nextValue;
      }
      if (playsPanelUi.minPlaysInput.placeholder !== getPlaysFilterPlaceholder()) {
        playsPanelUi.minPlaysInput.placeholder = getPlaysFilterPlaceholder();
      }
    }
    if (playsPanelUi && playsPanelUi.valueLabel) {
      playsPanelUi.valueLabel.textContent = formatPlaysFilterLabel(state.minPlays);
    }
    if (playsPanelUi && playsPanelUi.intro) {
      playsPanelUi.intro.textContent = getPlaysFilterIntro();
    }
    if (playsPanelUi && playsPanelUi.modeMinBtn && playsPanelUi.modeMaxBtn) {
      const isMax = isPlaysMaxMode();
      playsPanelUi.modeMinBtn.classList.toggle("is-active", !isMax);
      playsPanelUi.modeMaxBtn.classList.toggle("is-active", isMax);
      playsPanelUi.modeMinBtn.setAttribute("aria-pressed", isMax ? "false" : "true");
      playsPanelUi.modeMaxBtn.setAttribute("aria-pressed", isMax ? "true" : "false");
    }
    if (playsPanelUi && playsPanelUi.scopeHint) {
      playsPanelUi.scopeHint.textContent = isFeedPage()
        ? "Gilt nur auf der Feed-Seite"
        : "Auf der Feed-Seite verfügbar";
    }
    syncOverlayLayout();
    updateAutoLoadUi();
    updateDebugPanel();
  } catch (_) {}
}

function syncOverlayLayout() {
  const bar = document.getElementById(BAR_ID);
  const panel = document.getElementById(PANEL_ID);
  const playsPanel = document.getElementById(PLAYS_PANEL_ID);
  const gap = 12;
  if (bar) {
    const top = bar.getBoundingClientRect().bottom + gap;
    document.documentElement.style.setProperty("--digger-sc-panel-top", Math.round(top) + "px");
  }
  if (panel && panel.style.display !== "none") {
    const panelTop = panel.getBoundingClientRect().bottom + gap;
    document.documentElement.style.setProperty(
      "--digger-sc-plays-panel-top",
      Math.round(panelTop) + "px"
    );
  } else if (bar && playsPanel) {
    const top = bar.getBoundingClientRect().bottom + gap;
    document.documentElement.style.setProperty("--digger-sc-plays-panel-top", Math.round(top) + "px");
  }
}

function ensureOverlayLayoutListener() {
  if (overlayLayoutWired || dead) return;
  overlayLayoutWired = true;
  window.addEventListener(
    "resize",
    function () {
      if (!dead) syncOverlayLayout();
    },
    { passive: true }
  );
}

function ensureFeedBar() {
  if (dead) return;
  dedupeOverlays();
  // Remove legacy floating overlay from older versions
  const legacy = document.getElementById("digger-sc-overlay");
  if (legacy) {
    try {
      legacy.remove();
    } catch (_) {}
  }
  const existing = document.getElementById(BAR_ID);

  if (existing) {
    if (existing.parentNode !== document.body) {
      document.body.appendChild(existing);
    }
    if (!barUi || existing.dataset.wired !== "bar6") {
      if (existing.dataset.wired !== "bar6") {
        ensureAutoLoadBarSection(existing);
        ensureHideListenedBarSection(existing);
        existing.dataset.wired = "bar6";
      }
      bindBar(existing);
    }
    ensureOverlayLayoutListener();
    syncOverlayLayout();
    return;
  }

  if (feedBarInjecting) return;
  feedBarInjecting = true;
  try {
    injectFeedBar();
  } finally {
    feedBarInjecting = false;
  }
}

function ensureSidePanel() {
  if (dead) return;
  dedupeOverlays();
  const existing = document.getElementById(PANEL_ID);
  if (!isFeedPage()) {
    if (existing) existing.style.display = "none";
    return;
  }
  if (existing) {
    existing.style.display = "";
    if (existing.dataset.wired !== "panel9") {
      try {
        existing.remove();
      } catch (_) {}
      panelUi = null;
      if (sidePanelInjecting) return;
      sidePanelInjecting = true;
      try {
        injectSidePanel();
      } finally {
        sidePanelInjecting = false;
      }
      return;
    }
    if (!panelUi || panelNeedsRewire(existing)) {
      bindSidePanel(existing);
    }
    syncOverlayLayout();
    return;
  }

  if (sidePanelInjecting) return;
  sidePanelInjecting = true;
  try {
    injectSidePanel();
  } finally {
    sidePanelInjecting = false;
  }
}

function createHideListenedSection() {
  const label = document.createElement("label");
  label.className = "digger-sc-hide-listened";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "digger-sc-hide-listened-input";

  const ui = document.createElement("span");
  ui.className = "digger-sc-hide-listened-ui";
  ui.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "digger-sc-hide-listened-text";
  text.textContent = "Gehörte ausblenden";

  label.appendChild(input);
  label.appendChild(ui);
  label.appendChild(text);
  return { wrap: label, input: input };
}

function wireHideListenedSection(section) {
  if (!section || !section.input || section.input.dataset.wired === "1") return;
  section.input.dataset.wired = "1";
  section.input.checked = state.hideListened;
  section.input.addEventListener("change", function (e) {
    e.stopPropagation();
    setHideListened(section.input.checked, true);
  });
}

function createAutoLoadSection() {
  const wrap = document.createElement("div");
  wrap.className = "digger-sc-autoload-wrap";

  const autoLoadBtn = document.createElement("button");
  autoLoadBtn.type = "button";
  autoLoadBtn.className = "digger-sc-autoload-btn";
  autoLoadBtn.textContent = "Auto-Load";
  autoLoadBtn.setAttribute("aria-pressed", "false");

  const autoLoadStatus = document.createElement("span");
  autoLoadStatus.className = "digger-sc-autoload-status";
  autoLoadStatus.textContent = "Feed scrollen lassen (Hintergrund)";

  wrap.appendChild(autoLoadBtn);
  wrap.appendChild(autoLoadStatus);

  return { wrap: wrap, btn: autoLoadBtn, status: autoLoadStatus };
}

function wireAutoLoadSection(section) {
  if (!section || !section.btn || section.btn.dataset.wired === "1") return;
  section.btn.dataset.wired = "1";
  section.btn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    toggleAutoLoad();
  });
}

function ensureHideListenedBarSection(root) {
  if (!root || root.querySelector(".digger-sc-hide-listened")) return;
  const section = createHideListenedSection();
  const autoLoad = root.querySelector(".digger-sc-autoload-wrap");
  const meta = root.querySelector(".digger-sc-meta");
  if (autoLoad && autoLoad.parentNode === root) {
    root.insertBefore(section.wrap, autoLoad.nextSibling);
  } else if (meta) {
    root.insertBefore(section.wrap, meta);
  } else {
    root.appendChild(section.wrap);
  }
  wireHideListenedSection(section);
  if (barUi) barUi.hideListenedInput = section.input;
}

function ensureAutoLoadBarSection(root) {
  if (!root || root.querySelector(".digger-sc-autoload-wrap")) return;
  const section = createAutoLoadSection();
  const meta = root.querySelector(".digger-sc-meta");
  if (meta) root.insertBefore(section.wrap, meta);
  else root.appendChild(section.wrap);
  wireAutoLoadSection(section);
  if (barUi) {
    barUi.autoLoadBtn = section.btn;
    barUi.autoLoadStatus = section.status;
  }
}

function bindBar(root) {
  ensureAutoLoadBarSection(root);
  ensureHideListenedBarSection(root);
  barUi = {
    filterInput: root.querySelector(".digger-sc-filter-input"),
    clearBtn: root.querySelector(".digger-sc-clear-btn"),
    slider: root.querySelector(".digger-sc-rate-slider"),
    rateLabel: root.querySelector(".digger-sc-rate-value"),
    resetBtn: root.querySelector(".digger-sc-reset-btn"),
    autoLoadBtn: root.querySelector(".digger-sc-autoload-btn"),
    autoLoadStatus: root.querySelector(".digger-sc-autoload-status"),
    hideListenedInput: root.querySelector(".digger-sc-hide-listened-input"),
    meta: root.querySelector(".digger-sc-meta")
  };
  wireHideListenedSection({
    input: barUi.hideListenedInput
  });
  wireAutoLoadSection({
    btn: barUi.autoLoadBtn,
    status: barUi.autoLoadStatus
  });
  wireIsolation(root);
  updateBarUi();
}

function bindSidePanel(root) {
  panelUi = {
    setsRadio: root.querySelector(".digger-sc-sets-radio"),
    tracksRadio: root.querySelector(".digger-sc-tracks-radio"),
    freeDownloadsRadio: root.querySelector(".digger-sc-freedl-radio"),
    setsOption: root.querySelector(".digger-sc-sets-radio")
      ? root.querySelector(".digger-sc-sets-radio").closest(".digger-sc-panel-option")
      : null,
    tracksOption: root.querySelector(".digger-sc-tracks-radio")
      ? root.querySelector(".digger-sc-tracks-radio").closest(".digger-sc-panel-option")
      : null,
    freeDlOption: root.querySelector(".digger-sc-freedl-radio")
      ? root.querySelector(".digger-sc-freedl-radio").closest(".digger-sc-panel-option")
      : null,
    scopeHint: root.querySelector(".digger-sc-panel-hint")
  };
  wireSidePanelEvents(root);
  wireIsolation(root);
  updateBarUi();
  syncOverlayLayout();
}

function injectFeedBar() {
  ensureIsolatedForm();
  const root = document.createElement("div");
  root.id = BAR_ID;
  root.dataset.wired = "bar6";
  root.dataset.diggerScBar = "1";

  const label = document.createElement("span");
  label.className = "digger-sc-bar-title";
  label.textContent = "Digger";

  const filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.className = "digger-sc-filter-input";
  assignIsolatedField(filterInput, FIELD_IDS.titleFilter, "diggerScTitleFilter");
  filterInput.placeholder = "Titel enthält…";
  filterInput.autocomplete = "off";
  filterInput.spellcheck = false;
  filterInput.value = state.titleFilter;

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "digger-sc-clear-btn";
  clearBtn.textContent = "Leeren";

  const speedWrap = document.createElement("div");
  speedWrap.className = "digger-sc-speed-wrap";

  const speedLabel = document.createElement("span");
  speedLabel.className = "digger-sc-speed-label";
  speedLabel.textContent = "Speed";

  const speedControls = document.createElement("div");
  speedControls.className = "digger-sc-speed-controls";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "digger-sc-rate-slider";
  assignIsolatedField(slider, FIELD_IDS.rateSlider, "diggerScRate");
  slider.min = "-20";
  slider.max = "20";
  slider.step = "1";
  slider.value = String(rateToOffset(state.playbackRate));

  const rateLabel = document.createElement("span");
  rateLabel.className = "digger-sc-rate-value";
  rateLabel.textContent = formatOffset(rateToOffset(state.playbackRate));

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "digger-sc-reset-btn";
  resetBtn.textContent = "0%";
  resetBtn.title = "Speed zurücksetzen";

  const autoLoadSection = createAutoLoadSection();
  const hideListenedSection = createHideListenedSection();

  const meta = document.createElement("span");
  meta.className = "digger-sc-meta";
  meta.textContent = "Feed filtern";

  speedControls.appendChild(slider);
  speedControls.appendChild(rateLabel);
  speedControls.appendChild(resetBtn);
  speedWrap.appendChild(speedLabel);
  speedWrap.appendChild(speedControls);

  root.appendChild(label);
  root.appendChild(filterInput);
  root.appendChild(clearBtn);
  root.appendChild(speedWrap);
  root.appendChild(autoLoadSection.wrap);
  root.appendChild(hideListenedSection.wrap);
  root.appendChild(meta);

  document.body.appendChild(root);

  barUi = {
    filterInput: filterInput,
    clearBtn: clearBtn,
    slider: slider,
    rateLabel: rateLabel,
    resetBtn: resetBtn,
    autoLoadBtn: autoLoadSection.btn,
    autoLoadStatus: autoLoadSection.status,
    hideListenedInput: hideListenedSection.input,
    meta: meta
  };

  filterInput.addEventListener("input", function () {
    setTitleFilter(filterInput.value, true);
  });

  clearBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setTitleFilter("", true);
    filterInput.focus();
  });

  slider.addEventListener("input", function () {
    const offset = Number(slider.value) || 0;
    setPlaybackRate(1 + offset / 100, true);
  });

  resetBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setPlaybackRate(1, true);
  });

  wireAutoLoadSection(autoLoadSection);
  wireHideListenedSection(hideListenedSection);

  wireIsolation(root);
  ensureOverlayLayoutListener();
  updateBarUi();
  syncOverlayLayout();
  console.info("[Digger] feed bar mounted");
}

function applyPanelRadioState(radio, option) {
  if (!radio) return;
  debugNote(
    "only-mode · value=" + radio.value + " checked=" + radio.checked
  );
  setFeedOnlyMode(radio.checked ? radio.value : "", true);
  if (option) updatePanelOptionStatus(option, radio.checked);
  syncPanelOnlyRadios();
}

function syncPanelOnlyRadios() {
  if (!panelUi) return;
  const mode = state.feedOnlyMode;
  if (panelUi.setsRadio) panelUi.setsRadio.checked = mode === FEED_ONLY_MODES.SETS;
  if (panelUi.tracksRadio) panelUi.tracksRadio.checked = mode === FEED_ONLY_MODES.TRACKS;
  if (panelUi.freeDownloadsRadio) {
    panelUi.freeDownloadsRadio.checked = mode === FEED_ONLY_MODES.FREE_DOWNLOADS;
  }
  updatePanelOptionStatus(panelUi.setsOption, mode === FEED_ONLY_MODES.SETS);
  updatePanelOptionStatus(panelUi.tracksOption, mode === FEED_ONLY_MODES.TRACKS);
  updatePanelOptionStatus(panelUi.freeDlOption, mode === FEED_ONLY_MODES.FREE_DOWNLOADS);
}

function panelNeedsRewire(root) {
  const options = root.querySelectorAll(".digger-sc-panel-option");
  if (!options.length) return true;
  for (let i = 0; i < options.length; i++) {
    if (options[i].dataset.diggerEventsWired !== "2") return true;
  }
  return false;
}

function wireSidePanelEvents(root) {
  root.querySelectorAll(".digger-sc-panel-option").forEach(function (option) {
    if (option.dataset.diggerEventsWired === "2") return;

    const radio = option.querySelector('input[type="radio"]');
    if (!radio) return;

    radio.addEventListener("change", function (e) {
      e.stopPropagation();
      if (!radio.checked) return;
      if (state.feedOnlyMode === radio.value) return;
      applyPanelRadioState(radio, option);
    });

    option.addEventListener(
      "click",
      function (e) {
        e.stopPropagation();
        if (state.feedOnlyMode === radio.value) {
          e.preventDefault();
          radio.checked = false;
          applyPanelRadioState(radio, option);
          return;
        }
        if (e.target === radio) return;
        e.preventDefault();
        radio.checked = true;
        if (state.feedOnlyMode !== radio.value) {
          applyPanelRadioState(radio, option);
        }
      },
      true
    );

    option.dataset.diggerEventsWired = "2";
  });
}

function createPanelOnlyOption(config) {
  const label = document.createElement("label");
  label.className = "digger-sc-panel-option";

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.className = config.radioClass;
  radio.value = config.mode;
  assignIsolatedField(radio, config.inputId, "diggerScFeedOnlyMode");
  radio.checked = state.feedOnlyMode === config.mode;

  const body = document.createElement("span");
  body.className = "digger-sc-panel-option-body";

  const optionLabel = document.createElement("span");
  optionLabel.className = "digger-sc-panel-option-label";
  optionLabel.textContent = config.label;

  const optionDesc = document.createElement("span");
  optionDesc.className = "digger-sc-panel-option-desc";
  optionDesc.textContent = config.description;

  const status = document.createElement("span");
  status.className = "digger-sc-panel-option-status";
  status.setAttribute("aria-hidden", "true");

  body.appendChild(optionLabel);
  body.appendChild(optionDesc);
  label.appendChild(radio);
  label.appendChild(body);
  label.appendChild(status);

  updatePanelOptionStatus(label, radio.checked);
  return { root: label, radio: radio, status: status };
}

function updatePanelOptionStatus(optionRoot, active) {
  if (!optionRoot) return;
  optionRoot.classList.toggle("is-active", active);
  const status = optionRoot.querySelector(".digger-sc-panel-option-status");
  if (status) status.textContent = active ? "Aktiv" : "—";
}

function injectSidePanel() {
  ensureIsolatedForm();
  const root = document.createElement("aside");
  root.id = PANEL_ID;
  root.dataset.wired = "panel9";
  root.dataset.diggerScPanel = "1";

  const title = document.createElement("h3");
  title.className = "digger-sc-panel-title";
  title.textContent = "Nur anzeigen";

  const intro = document.createElement("p");
  intro.className = "digger-sc-panel-intro";
  intro.textContent = "Nur eine Kategorie gleichzeitig. Erneut klicken = alle anzeigen.";

  const options = document.createElement("div");
  options.className = "digger-sc-panel-options";

  const setsOption = createPanelOnlyOption({
    radioClass: "digger-sc-sets-radio",
    inputId: FIELD_IDS.onlySets,
    inputName: "diggerScOnlySets",
    mode: FEED_ONLY_MODES.SETS,
    label: "Nur DJ-Sets",
    description: "Länger als 20 Minuten"
  });

  const tracksOption = createPanelOnlyOption({
    radioClass: "digger-sc-tracks-radio",
    inputId: FIELD_IDS.onlyTracks,
    inputName: "diggerScOnlyTracks",
    mode: FEED_ONLY_MODES.TRACKS,
    label: "Nur Einzeltracks",
    description: "20 Minuten oder kürzer"
  });

  const freeDlOption = createPanelOnlyOption({
    radioClass: "digger-sc-freedl-radio",
    inputId: FIELD_IDS.onlyFreeDl,
    inputName: "diggerScOnlyFreeDownloads",
    mode: FEED_ONLY_MODES.FREE_DOWNLOADS,
    label: "Nur Free Downloads",
    description: "Titel mit Free, Free Download, Free DL oder Edit"
  });

  const hint = document.createElement("p");
  hint.className = "digger-sc-panel-hint";
  hint.textContent = "Gilt nur auf der Feed-Seite";

  options.appendChild(setsOption.root);
  options.appendChild(tracksOption.root);
  options.appendChild(freeDlOption.root);
  root.appendChild(title);
  root.appendChild(intro);
  root.appendChild(options);
  root.appendChild(hint);

  document.body.appendChild(root);

  panelUi = {
    setsRadio: setsOption.radio,
    tracksRadio: tracksOption.radio,
    freeDownloadsRadio: freeDlOption.radio,
    setsOption: setsOption.root,
    tracksOption: tracksOption.root,
    freeDlOption: freeDlOption.root,
    scopeHint: hint
  };

  wireSidePanelEvents(root);
  wireIsolation(root);
  updateBarUi();
  syncOverlayLayout();
}

function bindPlaysPanel(root) {
  playsPanelUi = {
    minPlaysInput: root.querySelector(".digger-sc-min-plays-input"),
    clearBtn: root.querySelector(".digger-sc-plays-clear-btn"),
    valueLabel: root.querySelector(".digger-sc-plays-value"),
    intro: root.querySelector(".digger-sc-plays-intro"),
    modeMinBtn: root.querySelector(".digger-sc-plays-mode-min"),
    modeMaxBtn: root.querySelector(".digger-sc-plays-mode-max"),
    scopeHint: root.querySelector(".digger-sc-plays-hint")
  };
  wireIsolation(root);
  updateBarUi();
  syncOverlayLayout();
}

function ensurePlaysPanel() {
  if (dead) return;
  dedupeOverlays();
  const existing = document.getElementById(PLAYS_PANEL_ID);
  if (!isFeedPage()) {
    if (existing) existing.style.display = "none";
    return;
  }
  if (existing) {
    existing.style.display = "";
    if (existing.dataset.wired !== "plays2") {
      try {
        existing.remove();
      } catch (_) {}
      playsPanelUi = null;
      if (playsPanelInjecting) return;
      playsPanelInjecting = true;
      try {
        injectPlaysPanel();
      } finally {
        playsPanelInjecting = false;
      }
      return;
    }
    if (!playsPanelUi) {
      bindPlaysPanel(existing);
    }
    syncOverlayLayout();
    return;
  }

  if (playsPanelInjecting) return;
  playsPanelInjecting = true;
  try {
    injectPlaysPanel();
  } finally {
    playsPanelInjecting = false;
  }
}

function injectPlaysPanel() {
  ensureIsolatedForm();
  const root = document.createElement("aside");
  root.id = PLAYS_PANEL_ID;
  root.dataset.wired = "plays2";
  root.dataset.diggerScPlaysPanel = "1";

  const title = document.createElement("h3");
  title.className = "digger-sc-plays-title";
  title.textContent = "Plays";

  const intro = document.createElement("p");
  intro.className = "digger-sc-plays-intro";
  intro.textContent = getPlaysFilterIntro();

  const modeSwitch = document.createElement("div");
  modeSwitch.className = "digger-sc-plays-mode-switch";
  modeSwitch.setAttribute("role", "group");
  modeSwitch.setAttribute("aria-label", "Plays-Filter Modus");

  const modeMinBtn = document.createElement("button");
  modeMinBtn.type = "button";
  modeMinBtn.className = "digger-sc-plays-mode-btn digger-sc-plays-mode-min";
  modeMinBtn.textContent = "Min";
  modeMinBtn.title = "Mindest-Plays filtern";
  modeMinBtn.setAttribute("aria-pressed", isPlaysMaxMode() ? "false" : "true");
  if (!isPlaysMaxMode()) modeMinBtn.classList.add("is-active");

  const modeMaxBtn = document.createElement("button");
  modeMaxBtn.type = "button";
  modeMaxBtn.className = "digger-sc-plays-mode-btn digger-sc-plays-mode-max";
  modeMaxBtn.textContent = "Max";
  modeMaxBtn.title = "Höchst-Plays filtern";
  modeMaxBtn.setAttribute("aria-pressed", isPlaysMaxMode() ? "true" : "false");
  if (isPlaysMaxMode()) modeMaxBtn.classList.add("is-active");

  modeSwitch.appendChild(modeMinBtn);
  modeSwitch.appendChild(modeMaxBtn);

  const minPlaysInput = document.createElement("input");
  minPlaysInput.type = "number";
  minPlaysInput.min = "0";
  minPlaysInput.step = "1";
  minPlaysInput.inputMode = "numeric";
  minPlaysInput.className = "digger-sc-min-plays-input";
  assignIsolatedField(minPlaysInput, FIELD_IDS.minPlays, "diggerScMinPlays");
  minPlaysInput.placeholder = getPlaysFilterPlaceholder();
  minPlaysInput.autocomplete = "off";
  minPlaysInput.value = state.minPlays > 0 ? String(state.minPlays) : "";

  const controls = document.createElement("div");
  controls.className = "digger-sc-plays-controls";

  const valueLabel = document.createElement("span");
  valueLabel.className = "digger-sc-plays-value";
  valueLabel.textContent = formatPlaysFilterLabel(state.minPlays);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "digger-sc-plays-clear-btn";
  clearBtn.textContent = "Alle";
  clearBtn.title = "Plays-Filter zurücksetzen";

  controls.appendChild(valueLabel);
  controls.appendChild(clearBtn);

  const presets = document.createElement("div");
  presets.className = "digger-sc-plays-presets";

  [1000, 10000, 100000].forEach(function (amount) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "digger-sc-plays-preset-btn";
    btn.textContent = formatPlayCount(amount);
    btn.title = (isPlaysMaxMode() ? "Höchstens " : "Mindestens ") +
      amount.toLocaleString("de-DE") +
      " Plays";
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      setMinPlays(amount, true);
      minPlaysInput.value = String(amount);
      minPlaysInput.focus();
    });
    presets.appendChild(btn);
  });

  const hint = document.createElement("p");
  hint.className = "digger-sc-plays-hint";
  hint.textContent = "Gilt nur auf der Feed-Seite";

  root.appendChild(title);
  root.appendChild(intro);
  root.appendChild(modeSwitch);
  root.appendChild(minPlaysInput);
  root.appendChild(controls);
  root.appendChild(presets);
  root.appendChild(hint);

  document.body.appendChild(root);

  playsPanelUi = {
    minPlaysInput: minPlaysInput,
    clearBtn: clearBtn,
    valueLabel: valueLabel,
    intro: intro,
    modeMinBtn: modeMinBtn,
    modeMaxBtn: modeMaxBtn,
    scopeHint: hint
  };

  modeMinBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setPlaysFilterMode(PLAYS_FILTER_MODES.MIN, true);
  });

  modeMaxBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setPlaysFilterMode(PLAYS_FILTER_MODES.MAX, true);
  });

  minPlaysInput.addEventListener("input", function () {
    setMinPlays(minPlaysInput.value, true);
  });

  clearBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    setMinPlays(0, true);
    minPlaysInput.value = "";
    minPlaysInput.focus();
  });

  wireIsolation(root);
  updateBarUi();
  syncOverlayLayout();
}
