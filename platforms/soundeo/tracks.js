function getWavDownloadLink(item) {
  if (!item) return null;
  return (
    item.querySelector('.download a.track-download-lnk[data-track-format="2"]') ||
    item.querySelector('.download a[data-track-format="2"]')
  );
}

function triggerWavDownload(item) {
  const link = getWavDownloadLink(item);
  if (!link) return false;
  link.click();
  return true;
}

function trimSoundeoUi(item) {
  if (!item) return;
  const fav = item.querySelector("button.favorites");
  if (fav) fav.hidden = true;

  const download = item.querySelector(".download");
  if (download) download.classList.add("sd-download-hidden");

  const links = item.querySelectorAll(
    '.download a.track-download-lnk, .download a[data-track-format]'
  );
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const format = link.getAttribute("data-track-format");
    const text = (link.textContent || "").replace(/\s+/g, " ").trim();
    const isMp3 = format === "1" || /^MP3\b/i.test(text);
    if (!isMp3) continue;
    link.hidden = true;
    link.style.setProperty("display", "none", "important");
    link.setAttribute("aria-hidden", "true");
  }
}

function isTrackPlaying(item) {
  const btn = item.querySelector("button.action[data-track-id]");
  return Boolean(btn && btn.classList.contains("stop"));
}

let panelPreviewAudio = null;
let panelPreviewBtn = null;

function isPanelTrackList(el) {
  return Boolean(el && el.closest(".sd-artist-tracks-list, .sd-label-tracks-list"));
}

function stopPanelPreview() {
  if (panelPreviewAudio) {
    try {
      panelPreviewAudio.pause();
    } catch (_) {}
    panelPreviewAudio = null;
  }
  if (panelPreviewBtn) {
    panelPreviewBtn.classList.remove("stop");
    panelPreviewBtn = null;
  }
}

function pauseOtherPageAudio(except) {
  try {
    const nodes = document.querySelectorAll("audio, video");
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i] === except) continue;
      try {
        nodes[i].pause();
      } catch (_) {}
    }
  } catch (_) {}
}

function resetPanelPlayButtons(activeBtn) {
  const buttons = document.querySelectorAll(
    ".sd-artist-tracks-list button.action[data-track-id], .sd-label-tracks-list button.action[data-track-id]"
  );
  for (let i = 0; i < buttons.length; i++) {
    if (buttons[i] !== activeBtn) buttons[i].classList.remove("stop");
  }
}

function togglePanelPreview(btn) {
  if (!btn || dead) return;

  const url = btn.getAttribute("data-track-url");
  const trackId = btn.getAttribute("data-track-id");
  if (!url) return;

  if (panelPreviewBtn === btn && panelPreviewAudio && !panelPreviewAudio.paused) {
    stopPanelPreview();
    return;
  }

  stopPanelPreview();
  pauseOtherPageAudio(null);
  resetPanelPlayButtons(btn);

  panelPreviewAudio = new Audio(url);
  panelPreviewBtn = btn;
  applyRateToEl(panelPreviewAudio);
  btn.classList.add("stop");

  panelPreviewAudio.addEventListener("ended", function () {
    if (panelPreviewBtn === btn) stopPanelPreview();
  });

  if (trackId) markPlayed(trackId);

  panelPreviewAudio.play().catch(function () {
    stopPanelPreview();
  });
}

function stopPanelPreviewInRoot(root) {
  if (!root || !panelPreviewBtn) return;
  if (root.contains(panelPreviewBtn)) stopPanelPreview();
}

function getPreviewAudio() {
  if (panelPreviewAudio && !panelPreviewAudio.paused && !panelPreviewAudio.ended) {
    return panelPreviewAudio;
  }
  const nodes = document.querySelectorAll("audio");
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el === panelPreviewAudio) continue;
    if (!el.paused && !el.ended) return el;
  }
  return nodes.length ? nodes[nodes.length - 1] : null;
}

function skipPreviewBy(seconds) {
  const audio = getPreviewAudio();
  if (!audio) return false;
  applyRateToEl(audio);
  const max = Number.isFinite(audio.duration) ? audio.duration : audio.currentTime + seconds;
  audio.currentTime = Math.min(audio.currentTime + seconds, max);
  if (audio.paused) {
    try {
      audio.play();
    } catch (_) {}
  }
  return true;
}

function skipTrackPreview(item) {
  if (!item || dead) return;
  if (isTrackPlaying(item)) {
    skipPreviewBy(SKIP_SECONDS);
    return;
  }

  const playBtn = item.querySelector("button.action[data-track-id]");
  if (!playBtn) return;
  playBtn.click();

  let attempts = 0;
  const waitAndSkip = function () {
    if (dead) return;
    attempts += 1;
    const audio = getPreviewAudio();
    if (audio && (!audio.paused || audio.readyState >= 2)) {
      skipPreviewBy(SKIP_SECONDS);
      return;
    }
    if (attempts < 24) setTimeout(waitAndSkip, 50);
  };
  setTimeout(waitAndSkip, 50);
}

const SKIP_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M3 5v14l10-7L3 5zm10 0v14l10-7-10-7z"/>' +
  "</svg>";

function ensureSkipButton(item) {
  if (!item || dead) return;
  const playBtn = item.querySelector("button.action[data-track-id]");
  if (!playBtn) return;

  let wrap = item.querySelector(".sd-play-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "sd-play-wrap";
    playBtn.parentNode.insertBefore(wrap, playBtn);
    wrap.appendChild(playBtn);
  } else if (playBtn.parentNode !== wrap) {
    wrap.insertBefore(playBtn, wrap.firstChild);
  }

  let skipBtn = wrap.querySelector(".sd-skip-btn");
  if (!skipBtn) {
    skipBtn = item.querySelector(".sd-skip-btn");
  }
  if (!skipBtn) {
    skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "sd-skip-btn";
    skipBtn.title = "30 Sekunden vorspringen";
    skipBtn.setAttribute("aria-label", "30 Sekunden vorspringen");
    skipBtn.innerHTML = SKIP_ICON_SVG;
    skipBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        skipTrackPreview(item);
      },
      true
    );
  }

  if (skipBtn.parentNode !== wrap) {
    wrap.appendChild(skipBtn);
  }
}

function getArtistActionsAnchor(item) {
  return (
    item.querySelector("button.favorites") ||
    item.querySelector(".download") ||
    null
  );
}

function positionArtistActions(item, bar) {
  const vote = item.querySelector(":scope > .vote");
  if (vote) {
    if (bar.parentNode !== item || bar.nextElementSibling !== vote) {
      item.insertBefore(bar, vote);
    }
    return;
  }

  const anchor = getArtistActionsAnchor(item);
  if (!anchor) {
    if (!bar.parentNode) item.appendChild(bar);
    return;
  }
  if (bar.parentNode !== item || bar.nextElementSibling !== anchor) {
    item.insertBefore(bar, anchor);
  }
}

function isDownloaded(item) {
  return Boolean(item.querySelector(".download.downloaded"));
}

function ensureArtistActions(item) {
  if (!item || dead) return;
  trimSoundeoUi(item);

  let bar = null;
  try {
    bar = item.querySelector(":scope > .sd-artist-actions");
  } catch (_) {
    bar = item.querySelector(".sd-artist-actions");
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "sd-artist-actions";
    item.appendChild(bar);
  }

  let favBtn = bar.querySelector(".sd-artist-fav");
  if (!favBtn) {
    favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "sd-artist-btn sd-artist-fav";
    favBtn.title = "Artist favorisieren";
    favBtn.setAttribute("aria-label", "Artist favorisieren");
    favBtn.textContent = "★";
    favBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        const artists = getTrackArtists(item);
        if (!artists.length) return;
        toggleFavoriteArtists(artists);
      },
      true
    );
    bar.appendChild(favBtn);
  }

  let blockBtn = bar.querySelector(".sd-artist-block");
  if (!blockBtn) {
    blockBtn = document.createElement("button");
    blockBtn.type = "button";
    blockBtn.className = "sd-artist-btn sd-artist-block";
    blockBtn.title = "Artist blockieren";
    blockBtn.setAttribute("aria-label", "Artist blockieren");
    blockBtn.textContent = "✕";
    blockBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        const artists = getTrackArtists(item);
        if (!artists.length) return;
        toggleBlockedArtists(artists);
      },
      true
    );
    bar.appendChild(blockBtn);
  }

  let dlBtn = bar.querySelector(".sd-artist-download");
  if (!dlBtn) {
    dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "sd-artist-btn sd-artist-download";
    dlBtn.title = "WAV herunterladen";
    dlBtn.setAttribute("aria-label", "WAV herunterladen");
    dlBtn.textContent = "↓";
    dlBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        triggerWavDownload(item);
        if (typeof recordSdDownload === "function") recordSdDownload(item);
      },
      true
    );
    bar.appendChild(dlBtn);
  }

  let wantBtn = bar.querySelector(".sd-artist-want");
  if (!wantBtn) {
    wantBtn = document.createElement("button");
    wantBtn.type = "button";
    wantBtn.className = "sd-artist-btn sd-artist-want";
    wantBtn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleWantTrack(item);
      },
      true
    );
    bar.appendChild(wantBtn);
  }

  ensureArtistTracksButton(item, bar);
  ensureLabelTracksButton(item, bar);

  positionArtistActions(item, bar);

  const trackId = item.getAttribute("data-track-id");
  const wanted = isSoundeoTrackWanted(item, trackId);
  const blocked = trackHasBlockedArtist(item);
  const fav = trackHasFavoriteArtist(item);
  const downloaded = isDownloaded(item);
  if (favBtn) favBtn.classList.toggle("is-active", fav && !blocked);
  if (blockBtn) blockBtn.classList.toggle("is-active", blocked);
  if (dlBtn) {
    dlBtn.classList.toggle("is-downloaded", downloaded);
    dlBtn.title = downloaded ? "WAV herunterladen (bereits geladen)" : "WAV herunterladen";
  }
  if (wantBtn) {
    wantBtn.classList.toggle("is-active", wanted);
    wantBtn.textContent = wanted ? "✓" : "⬇";
    wantBtn.title = wanted
      ? "Download-Vormerkung entfernen"
      : "Zum baldigen Download vormerken";
    wantBtn.setAttribute("aria-label", wantBtn.title);
    wantBtn.setAttribute("aria-pressed", wanted ? "true" : "false");
  }
  if (wanted) item.setAttribute(WANT_ATTR, "");
  else item.removeAttribute(WANT_ATTR);
}

function toggleWantTrack(item) {
  if (dead || !item) return;
  const trackId = item.getAttribute("data-track-id");
  if (!trackId) return;
  const id = String(trackId);
  const next = !isSoundeoTrackWanted(item, id);
  if (next) state.wantIds.add(id);
  else state.wantIds.delete(id);

  const play = buildSoundeoPlayPayload(item, id);
  // Keep local meta in sync immediately for title matching
  if (next) {
    const fp = wantFingerprint(play.artist, play.title);
    if (fp) {
      state.wantMetaByFp[fp] = {
        artist: play.artist,
        title: play.title,
        artistNorm: normalizeWantText(play.artist),
        titleNorm: normalizeWantText(play.title),
        keys: [id],
        trackId: id
      };
    }
  } else {
    const fp = wantFingerprint(play.artist, play.title);
    if (fp && state.wantMetaByFp[fp]) delete state.wantMetaByFp[fp];
  }

  sendToBackground({
    type: next ? "BG_WANT_DOWNLOAD" : "BG_UNWANT_DOWNLOAD",
    play: play
  });
  if (window.DiggerClientLog) {
    window.DiggerClientLog.report("info", next ? "want click (soundeo)" : "unwant click (soundeo)", {
      source: "want-ui",
      platform: "soundeo",
      context: {
        step: "ui-click",
        wanted: next,
        trackId: id,
        fingerprint: wantFingerprint(play.artist, play.title),
        play: play
      }
    });
  }
  // Immediate UI update (don't wait for sync roundtrip)
  ensureArtistActions(item);
}

function mergeWantKeys(keys, action, meta) {
  if (meta && typeof meta === "object") setWantMetaMap(meta);
  if (action === "clear") {
    state.wantIds.clear();
    state.wantMetaByFp = {};
    scheduleApply();
    if (window.DiggerClientLog) {
      window.DiggerClientLog.warn("want sync clear (soundeo)", {
        source: "want-ui",
        platform: "soundeo",
        context: { step: "ui-merge", action: "clear" }
      });
    }
    return;
  }
  if (!Array.isArray(keys)) {
    if (meta) scheduleApply();
    return;
  }
  let changed = false;
  const applied = [];
  const skippedSc = [];
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i] || "");
    if (!key) continue;
    if (key.indexOf("sc:") === 0) {
      skippedSc.push(key);
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
    window.DiggerClientLog.report("info", "want sync merge (soundeo)", {
      source: "want-ui",
      platform: "soundeo",
      context: {
        step: "ui-merge",
        action: action || "add",
        incoming: keys.length,
        applied: applied,
        skippedSc: skippedSc.slice(0, 20),
        wantCount: state.wantIds.size,
        metaCount: Object.keys(state.wantMetaByFp).length
      }
    });
  }
  if (changed || meta) scheduleApply();
}
