/**
 * Modal for uncertain cross-platform track matches.
 * Shared by Soundeo + SoundCloud content scripts.
 */
(function (root) {
  const MODAL_ID = "digger-match-modal";
  const SKIP_KEY = "diggerSkipMatchPrompts";
  const MIN_SCORE_KEY = "diggerMatchMinScore";
  const seenPairs = new Set();
  const queue = [];
  let busy = false;
  let skipPrompts = false;
  let skipLoaded = false;
  let minScore = 0;
  let prefsLoaded = false;

  function pairKey(prompt) {
    if (!prompt) return "";
    const a = String(prompt.trackId || "");
    const b = String(prompt.candidateTrackId || "");
    return a < b ? a + "|" + b : b + "|" + a;
  }

  function formatDuration(sec) {
    const n = Math.round(Number(sec) || 0);
    if (!n) return "";
    const m = Math.floor(n / 60);
    const s = n % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function formatMeta(parts) {
    return parts.filter(Boolean).join(" · ");
  }

  function displayName(artist, title) {
    const a = String(artist || "").trim();
    const t = String(title || "").trim();
    if (a && t) return a + " – " + t;
    return t || a || "Unbekannt";
  }

  function clampMinScore(value) {
    if (typeof root.sanitizeMatchMinScore === "function") {
      return root.sanitizeMatchMinScore(value);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(0.95, Math.round(n * 100) / 100);
  }

  function sendBg(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function loadPreferences() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get([SKIP_KEY, MIN_SCORE_KEY], function (data) {
          if (chrome.runtime.lastError) {
            skipPrompts = false;
            minScore = 0;
            skipLoaded = true;
            prefsLoaded = true;
            resolve({ skip: false, minScore: 0 });
            return;
          }
          skipPrompts = Boolean(data && data[SKIP_KEY]);
          minScore = clampMinScore(data && data[MIN_SCORE_KEY]);
          skipLoaded = true;
          prefsLoaded = true;
          resolve({ skip: skipPrompts, minScore: minScore });
        });
      } catch (_) {
        skipPrompts = false;
        minScore = 0;
        skipLoaded = true;
        prefsLoaded = true;
        resolve({ skip: false, minScore: 0 });
      }
    });
  }

  function persistSkipPreference(value) {
    skipPrompts = Boolean(value);
    try {
      chrome.storage.sync.set({ [SKIP_KEY]: skipPrompts });
    } catch (_) {}
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "sync") return;
      if (changes[SKIP_KEY]) {
        skipPrompts = Boolean(changes[SKIP_KEY].newValue);
        skipLoaded = true;
        if (skipPrompts) {
          queue.length = 0;
          busy = false;
          closeModal();
        }
      }
      if (changes[MIN_SCORE_KEY]) {
        minScore = clampMinScore(changes[MIN_SCORE_KEY].newValue);
        prefsLoaded = true;
      }
    });
  } catch (_) {}

  function closeModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) {
      try {
        el.remove();
      } catch (_) {}
    }
  }

  function passesMinScore(prompt) {
    if (!minScore) return true;
    return (Number(prompt && prompt.score) || 0) >= minScore;
  }

  function openNext() {
    if (busy || skipPrompts) return;
    while (queue.length) {
      const next = queue.shift();
      const key = pairKey(next);
      if (!key || seenPairs.has(key)) continue;
      if (!passesMinScore(next)) continue;
      seenPairs.add(key);
      busy = true;
      renderModal(next);
      return;
    }
  }

  function finishAndContinue() {
    busy = false;
    closeModal();
    openNext();
  }

  function renderModal(prompt) {
    closeModal();
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.className = "digger-match-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Track-Match bestätigen");

    const card = document.createElement("div");
    card.className = "digger-match-card";

    const title = document.createElement("h2");
    title.className = "digger-match-title";
    title.textContent = "Derselbe Track?";

    const intro = document.createElement("p");
    intro.className = "digger-match-intro";
    intro.textContent =
      "Ähnlicher Treffer auf einer anderen Plattform. Zusammenführen?";

    const score = document.createElement("div");
    score.className = "digger-match-score";
    const pct = Math.round((Number(prompt.score) || 0) * 100);
    score.textContent = "Ähnlichkeit " + pct + "%";

    function makeRow(label, name, meta) {
      const row = document.createElement("div");
      row.className = "digger-match-row";
      const lab = document.createElement("div");
      lab.className = "digger-match-row-label";
      lab.textContent = label;
      const nameEl = document.createElement("div");
      nameEl.className = "digger-match-row-name";
      nameEl.textContent = name;
      row.appendChild(lab);
      row.appendChild(nameEl);
      if (meta) {
        const metaEl = document.createElement("div");
        metaEl.className = "digger-match-row-meta";
        metaEl.textContent = meta;
        row.appendChild(metaEl);
      }
      return row;
    }

    const sourceMeta = formatMeta([
      prompt.sourcePlatform || "aktuell",
      formatDuration(prompt.sourceDurationSec),
      prompt.sourceBpm ? Math.round(prompt.sourceBpm) + " BPM" : "",
      prompt.sourceLabel || ""
    ]);
    const candMeta = formatMeta([
      "bereits in DB",
      formatDuration(prompt.candidateDurationSec),
      prompt.candidateBpm ? Math.round(prompt.candidateBpm) + " BPM" : "",
      prompt.candidateLabel || "",
      prompt.candidateMusicalKey || ""
    ]);

    const skipLabel = document.createElement("label");
    skipLabel.className = "digger-match-skip";
    const skipInput = document.createElement("input");
    skipInput.type = "checkbox";
    skipInput.className = "digger-match-skip-input";
    const skipText = document.createElement("span");
    skipText.textContent = "Nicht mehr fragen";
    skipLabel.appendChild(skipInput);
    skipLabel.appendChild(skipText);

    const actions = document.createElement("div");
    actions.className = "digger-match-actions";

    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "digger-match-btn digger-match-btn-no";
    noBtn.textContent = "Nein, anders";

    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "digger-match-btn digger-match-btn-yes";
    yesBtn.textContent = "Ja, zusammenführen";

    function maybePersistSkip() {
      if (skipInput.checked) persistSkipPreference(true);
    }

    noBtn.addEventListener("click", function () {
      noBtn.disabled = true;
      yesBtn.disabled = true;
      maybePersistSkip();
      sendBg({
        type: "BG_MATCH_REJECT",
        trackId: prompt.trackId,
        candidateTrackId: prompt.candidateTrackId
      }).then(finishAndContinue);
    });

    yesBtn.addEventListener("click", function () {
      noBtn.disabled = true;
      yesBtn.disabled = true;
      maybePersistSkip();
      sendBg({
        type: "BG_MATCH_CONFIRM",
        trackId: prompt.trackId,
        candidateTrackId: prompt.candidateTrackId,
        keepTrackId: prompt.trackId
      }).then(finishAndContinue);
    });

    actions.appendChild(noBtn);
    actions.appendChild(yesBtn);

    card.appendChild(title);
    card.appendChild(intro);
    card.appendChild(score);
    card.appendChild(
      makeRow(
        "Dieser Track",
        displayName(prompt.sourceArtist, prompt.sourceTitle),
        sourceMeta
      )
    );
    card.appendChild(
      makeRow(
        "Möglicher Treffer",
        displayName(prompt.candidateArtist, prompt.candidateTitle),
        candMeta
      )
    );
    card.appendChild(skipLabel);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);
  }

  function enqueueMatchPrompts(prompts) {
    if (!Array.isArray(prompts) || !prompts.length) return;
    const run = function () {
      if (skipPrompts) return;
      for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i];
        if (!p || !p.trackId || !p.candidateTrackId) continue;
        if (!passesMinScore(p)) continue;
        const key = pairKey(p);
        if (!key || seenPairs.has(key)) continue;
        let exists = false;
        for (let q = 0; q < queue.length; q++) {
          if (pairKey(queue[q]) === key) {
            exists = true;
            break;
          }
        }
        if (!exists) queue.push(p);
      }
      openNext();
    };
    if (!prefsLoaded || !skipLoaded) {
      loadPreferences().then(run);
      return;
    }
    run();
  }

  root.DiggerMatchModal = {
    enqueue: enqueueMatchPrompts
  };
})(typeof window !== "undefined" ? window : self);
