function wireOverlayIsolation(root) {
  if (!root || root.dataset.overlayIso === "1") return;
  root.dataset.overlayIso = "1";
  const stop = function (e) {
    e.stopPropagation();
  };
  root.addEventListener("mousedown", stop, false);
  root.addEventListener("pointerdown", stop, false);
  root.addEventListener("click", stop, false);
}

function injectTempoWidget() {
  if (dead || !document.body) return;
  let root = document.getElementById("soundeo-digger-tempo");
  if (root && root.dataset.wired !== "overlay4") {
    try {
      root.remove();
    } catch (_) {}
    root = null;
  }
  if (root && root.dataset.wired === "overlay4") {
    tempoUi = {
      slider: root.querySelector(".sd-tempo-slider"),
      label: root.querySelector(".sd-tempo-value"),
      meta: root.querySelector(".sd-tempo-meta"),
      genreSection: root.querySelector(".sd-genre-section"),
      genreCount: root.querySelector(".sd-genre-count"),
      genreRow: root.querySelector(".sd-genre-row"),
      randomWeek: root.querySelector(".sd-random-week-btn"),
      randomMonth: root.querySelector(".sd-random-month-btn")
    };
    wireOverlayIsolation(root);
    updateTempoUi();
    renderOverlayGenres();
    return;
  }

  root = document.createElement("div");
  root.id = "soundeo-digger-tempo";

  const row = document.createElement("div");
  row.className = "sd-tempo-row";

  const title = document.createElement("span");
  title.className = "sd-tempo-title";
  title.textContent = "BPM";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "sd-tempo-slider";
  slider.min = String(BPM_SLIDER_MIN);
  slider.max = String(BPM_SLIDER_MAX);
  slider.step = "1";
  slider.value = String(normalizeTargetBpm(state.targetBpm));

  const label = document.createElement("span");
  label.className = "sd-tempo-value";
  label.textContent = String(normalizeTargetBpm(state.targetBpm));

  row.appendChild(title);
  row.appendChild(slider);
  row.appendChild(label);

  const meta = document.createElement("div");
  meta.className = "sd-tempo-meta";
  meta.textContent = "Track-BPM wird geladen…";

  const genreSection = document.createElement("div");
  genreSection.className = "sd-genre-section";
  genreSection.hidden = true;

  const genreHead = document.createElement("div");
  genreHead.className = "sd-genre-head";

  const genreLabel = document.createElement("span");
  genreLabel.className = "sd-genre-label";
  genreLabel.textContent = "Zufalls-Genres";

  const genreCount = document.createElement("span");
  genreCount.className = "sd-genre-count";
  genreCount.textContent = "0/0 aktiv";

  const genreQuick = document.createElement("div");
  genreQuick.className = "sd-genre-quick";

  const genreAllBtn = document.createElement("button");
  genreAllBtn.type = "button";
  genreAllBtn.className = "sd-genre-quick-btn";
  genreAllBtn.textContent = "Alle";
  genreAllBtn.title = "Alle Favoriten für Random aktivieren";
  genreAllBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    selectAllFavoriteGenres();
  });

  const genreNoneBtn = document.createElement("button");
  genreNoneBtn.type = "button";
  genreNoneBtn.className = "sd-genre-quick-btn";
  genreNoneBtn.textContent = "Keine";
  genreNoneBtn.title = "Keine Genres für Random (aktuelles Genre bleibt)";
  genreNoneBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    selectNoFavoriteGenres();
  });

  genreQuick.appendChild(genreAllBtn);
  genreQuick.appendChild(genreNoneBtn);
  genreHead.appendChild(genreLabel);
  genreHead.appendChild(genreCount);
  genreHead.appendChild(genreQuick);

  const genreRow = document.createElement("div");
  genreRow.className = "sd-genre-row";

  genreSection.appendChild(genreHead);
  genreSection.appendChild(genreRow);

  const actions = document.createElement("div");
  actions.className = "sd-overlay-actions";

  const randomBtn = document.createElement("button");
  randomBtn.type = "button";
  randomBtn.className = "sd-random-week-btn";
  randomBtn.textContent = "Zufällige Woche";
  randomBtn.title = "Zufällige Woche · aktive Genres im Filter";
  randomBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    goRandomWeek();
  });

  const randomMonthBtn = document.createElement("button");
  randomMonthBtn.type = "button";
  randomMonthBtn.className = "sd-random-month-btn";
  randomMonthBtn.textContent = "Zufälliger Monat";
  randomMonthBtn.title = "Zufälliger Monat · aktive Genres im Filter";
  randomMonthBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    goRandomMonth();
  });

  actions.appendChild(randomBtn);
  actions.appendChild(randomMonthBtn);
  root.appendChild(row);
  root.appendChild(meta);
  root.appendChild(genreSection);
  root.appendChild(actions);
  document.body.appendChild(root);

  root.dataset.wired = "overlay4";
  tempoUi = {
    slider: slider,
    label: label,
    meta: meta,
    genreSection: genreSection,
    genreCount: genreCount,
    genreRow: genreRow,
    randomWeek: randomBtn,
    randomMonth: randomMonthBtn
  };

  slider.addEventListener("input", function () {
    setTargetBpm(slider.value, true);
  });

  wireOverlayIsolation(root);

  updateTempoUi();
  renderOverlayGenres();
}
