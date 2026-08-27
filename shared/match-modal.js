/**
 * Modal for uncertain cross-platform track matches.
 * Shared by Soundeo + SoundCloud content scripts.
 */
(function (root) {
  const MODAL_ID = "digger-match-modal";
  const seenPairs = new Set();
  const queue = [];
  let busy = false;

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

  function closeModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) {
      try {
        el.remove();
      } catch (_) {}
    }
  }

  function openNext() {
    if (busy) return;
    while (queue.length) {
      const next = queue.shift();
      const key = pairKey(next);
      if (!key || seenPairs.has(key)) continue;
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

    noBtn.addEventListener("click", function () {
      noBtn.disabled = true;
      yesBtn.disabled = true;
      sendBg({
        type: "BG_MATCH_REJECT",
        trackId: prompt.trackId,
        candidateTrackId: prompt.candidateTrackId
      }).then(finishAndContinue);
    });

    yesBtn.addEventListener("click", function () {
      noBtn.disabled = true;
      yesBtn.disabled = true;
      sendBg({
        type: "BG_MATCH_CONFIRM",
        trackId: prompt.trackId,
        candidateTrackId: prompt.candidateTrackId,
        keepTrackId: prompt.trackId
      }).then(finishAndContinue);
    });

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        // Skip for now (same as reject? better leave open — user must choose)
      }
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
    card.appendChild(actions);
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);
  }

  function enqueueMatchPrompts(prompts) {
    if (!Array.isArray(prompts) || !prompts.length) return;
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      if (!p || !p.trackId || !p.candidateTrackId) continue;
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
  }

  root.DiggerMatchModal = {
    enqueue: enqueueMatchPrompts
  };
})(typeof window !== "undefined" ? window : self);
