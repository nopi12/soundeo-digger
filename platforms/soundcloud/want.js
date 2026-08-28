const WANT_ATTR = "data-digger-sc-want";
const WANT_BTN_CLASS = "digger-sc-want-btn";

function wantKey(url) {
  return playedKey(url);
}

function isItemWanted(item) {
  const key = wantKey(getTrackUrl(item));
  return key ? state.wantIds.has(key) : false;
}

function findWantActionsHost(item) {
  if (!item) return null;
  return (
    item.querySelector(".soundActions .sc-button-group") ||
    item.querySelector(".soundActions") ||
    item.querySelector(".sound__soundActions .sc-button-group") ||
    item.querySelector(".sound__soundActions") ||
    item.querySelector("[class*='soundActions'] .sc-button-group") ||
    item.querySelector("[class*='soundActions']")
  );
}

function needsWantSync(item) {
  if (!item || !isWantEligiblePage()) return false;
  const url = getTrackUrl(item);
  if (!url || !isTrackPath(url)) return Boolean(item.querySelector("." + WANT_BTN_CLASS));
  const wanted = isItemWanted(item);
  const hasAttr = item.hasAttribute(WANT_ATTR);
  const btn = item.querySelector("." + WANT_BTN_CLASS);
  if (wanted !== hasAttr) return true;
  if (!btn) return true;
  if (btn.classList.contains("is-active") !== wanted) return true;
  const label = wanted ? "Vorgemerkt" : "Vormerken";
  if (btn.textContent !== label) return true;
  return false;
}

function applyWantMarkers(item) {
  if (!item) return;
  if (isItemWanted(item)) item.setAttribute(WANT_ATTR, "");
  else item.removeAttribute(WANT_ATTR);
  syncWantButton(item);
}

function syncWantButton(item) {
  if (!item || !isWantEligiblePage()) {
    removeWantButton(item);
    return;
  }
  const url = getTrackUrl(item);
  if (!url || !isTrackPath(url)) {
    removeWantButton(item);
    return;
  }

  const host = findWantActionsHost(item);
  let btn = item.querySelector("." + WANT_BTN_CLASS);
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = WANT_BTN_CLASS + " sc-button sc-button-small sc-button-responsive";
    btn.addEventListener(
      "click",
      function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleWantItem(item);
      },
      true
    );
  }

  if (host) {
    if (btn.parentNode !== host) host.appendChild(btn);
  } else if (btn.parentNode !== item) {
    item.appendChild(btn);
  }

  const wanted = isItemWanted(item);
  btn.classList.toggle("is-active", wanted);
  btn.classList.toggle("sc-button-selected", wanted);
  btn.textContent = wanted ? "Vorgemerkt" : "Vormerken";
  btn.title = wanted
    ? "Vormerken entfernen"
    : "Vormerken (später laden)";
  btn.setAttribute("aria-pressed", wanted ? "true" : "false");
}

function removeWantButton(item) {
  if (!item) return;
  const btn = item.querySelector("." + WANT_BTN_CLASS);
  if (btn) {
    try {
      btn.remove();
    } catch (_) {}
  }
  item.removeAttribute(WANT_ATTR);
}

function clearWantButtons() {
  let buttons;
  try {
    buttons = document.querySelectorAll("." + WANT_BTN_CLASS);
  } catch (_) {
    return;
  }
  for (let i = 0; i < buttons.length; i++) {
    try {
      buttons[i].remove();
    } catch (_) {}
  }
  let marked;
  try {
    marked = document.querySelectorAll("[" + WANT_ATTR + "]");
  } catch (_) {
    return;
  }
  for (let i = 0; i < marked.length; i++) {
    marked[i].removeAttribute(WANT_ATTR);
  }
}

function setWantLocal(key, wanted) {
  if (!key) return;
  if (wanted) state.wantIds.add(key);
  else state.wantIds.delete(key);
}

function toggleWantItem(item) {
  if (dead || !item) return;
  const url = getTrackUrl(item);
  const key = wantKey(url);
  if (!key) return;
  const next = !state.wantIds.has(key);
  setWantLocal(key, next);
  applyWantMarkers(item);
  const payload = buildScPlayPayload(url, item);
  sendToBackground({
    type: next ? "BG_WANT_DOWNLOAD" : "BG_UNWANT_DOWNLOAD",
    play: payload
  });
  if (window.DiggerClientLog) {
    window.DiggerClientLog.report("info", next ? "want click (soundcloud)" : "unwant click (soundcloud)", {
      source: "want-ui",
      platform: "soundcloud",
      context: {
        step: "ui-click",
        wanted: next,
        key: key,
        play: payload
      }
    });
  }
}

function mergeWantKeys(keys, action) {
  if (action === "clear") {
    state.wantIds.clear();
    clearWantButtons();
    scheduleApply();
    if (window.DiggerClientLog) {
      window.DiggerClientLog.warn("want sync clear (soundcloud)", {
        source: "want-ui",
        platform: "soundcloud",
        context: { step: "ui-merge", action: "clear" }
      });
    }
    return;
  }
  if (!Array.isArray(keys)) return;
  let changed = false;
  const applied = [];
  const skippedSoundeo = [];
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (!key) continue;
    if (key.indexOf("sc:") !== 0) {
      skippedSoundeo.push(key);
      continue;
    }
    if (action === "remove") {
      if (state.wantIds.delete(key)) {
        changed = true;
        applied.push(key);
      }
    } else if (!state.wantIds.has(key)) {
      state.wantIds.add(key);
      changed = true;
      applied.push(key);
    }
  }
  if (window.DiggerClientLog) {
    window.DiggerClientLog.report("info", "want sync merge (soundcloud)", {
      source: "want-ui",
      platform: "soundcloud",
      context: {
        step: "ui-merge",
        action: action || "add",
        incoming: keys.length,
        applied: applied,
        skippedSoundeo: skippedSoundeo.slice(0, 20),
        wantCount: state.wantIds.size
      }
    });
  }
  if (changed) scheduleApply();
}
