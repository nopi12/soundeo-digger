const artistInfoCache = new Map();
const artistTracksCache = new Map();
let openArtistPanelItem = null;
let artistTracksFetchToken = 0;

function absoluteUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, location.origin).href;
  } catch (_) {
    return null;
  }
}

function parseArtistInfoFromTrackHtml(html) {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const span = doc.querySelector(".full-artist-link");
  if (!span) return null;

  const link =
    span.querySelector('a[href*="artistFilter="]') || span.querySelector("a[href]");
  if (!link) return null;

  const href = link.getAttribute("href") || "";
  const name = String(link.textContent || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!name) return null;

  const sup = span.querySelector("sup");
  const countText = sup ? String(sup.textContent || "").trim() : "";
  const trackCount = /^\d+$/.test(countText) ? Number(countText) : null;

  const favBtn = span.querySelector("[data-artist-id]");
  const artistId = favBtn ? String(favBtn.getAttribute("data-artist-id") || "") : "";

  const url = absoluteUrl(href);
  if (!url) return null;

  return {
    href: href,
    url: url,
    name: name,
    trackCount: trackCount,
    artistId: artistId || null
  };
}

function parseArtistTracksPage(html, sourceTrackId) {
  if (!html) return { html: "", nextPageUrl: null, loadedCount: 0 };

  const doc = new DOMParser().parseFromString(html, "text/html");
  const left = doc.querySelector(".left");
  if (!left) return { html: "", nextPageUrl: null, loadedCount: 0 };

  const chunks = [];
  const nodes = left.children;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node || node.nodeType !== 1) continue;
    if (node.classList.contains("trackitem")) {
      const id = node.getAttribute("data-track-id");
      if (sourceTrackId && id === String(sourceTrackId)) continue;
      chunks.push(node.outerHTML);
      continue;
    }
    if (node.matches("h1, .folder, .pagination")) {
      chunks.push(node.outerHTML);
    }
  }

  let nextPageUrl = null;
  const pagination = doc.querySelector(".pagination");
  if (pagination) {
    const active = pagination.querySelector("li.active");
    let nextLink = null;
    if (active && active.nextElementSibling) {
      nextLink = active.nextElementSibling.querySelector("a[href]");
    }
    if (!nextLink) {
      nextLink = pagination.querySelector('a[href*="page="]');
    }
    if (nextLink) {
      nextPageUrl = absoluteUrl(nextLink.getAttribute("href"));
    }
  }

  return {
    html: chunks.join("\n"),
    nextPageUrl: nextPageUrl,
    loadedCount: left.querySelectorAll(".trackitem").length
  };
}

async function fetchHtml(url) {
  if (!url || dead) return null;
  try {
    const res = await fetch(url, { credentials: "same-origin", cache: "force-cache" });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  }
}

async function resolveArtistInfo(item) {
  const trackId = item ? item.getAttribute("data-track-id") : null;
  if (trackId && artistInfoCache.has(String(trackId))) {
    return artistInfoCache.get(String(trackId));
  }

  const trackUrl = getTrackUrl(item);
  if (!trackUrl) return null;

  const html = await fetchHtml(trackUrl);
  if (!html || dead) return null;

  const info = parseArtistInfoFromTrackHtml(html);
  if (!info) return null;

  if (trackId) artistInfoCache.set(String(trackId), info);
  if (info.artistId) artistInfoCache.set("artist:" + info.artistId, info);
  return info;
}

async function loadArtistTracksHtml(info, sourceTrackId, pageUrl) {
  const cacheKey =
    (info.artistId ? "artist:" + info.artistId : info.url) + "|" + (pageUrl || info.url);
  if (artistTracksCache.has(cacheKey)) {
    return artistTracksCache.get(cacheKey);
  }

  const html = await fetchHtml(pageUrl || info.url);
  if (!html || dead) return null;

  const parsed = parseArtistTracksPage(html, sourceTrackId);
  artistTracksCache.set(cacheKey, parsed);
  return parsed;
}

function getArtistTracksPanel(item) {
  if (!item) return null;
  let panel = item.nextElementSibling;
  if (panel && panel.classList.contains("sd-artist-tracks-panel")) return panel;

  panel = item.parentNode
    ? item.parentNode.querySelector(
        '.sd-artist-tracks-panel[data-for-track-id="' + item.getAttribute("data-track-id") + '"]'
      )
    : null;
  return panel || null;
}

function ensureArtistTracksPanel(item) {
  let panel = getArtistTracksPanel(item);
  if (panel) return panel;

  panel = document.createElement("div");
  panel.className = "sd-artist-tracks-panel";
  panel.hidden = true;
  panel.dataset.forTrackId = item.getAttribute("data-track-id") || "";

  const head = document.createElement("div");
  head.className = "sd-artist-tracks-head";

  const title = document.createElement("span");
  title.className = "sd-artist-tracks-title";
  title.textContent = "Artist-Tracks";

  const count = document.createElement("sup");
  count.className = "sd-artist-tracks-count";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "sd-artist-tracks-close";
  closeBtn.title = "Schließen";
  closeBtn.setAttribute("aria-label", "Schließen");
  closeBtn.textContent = "×";
  closeBtn.addEventListener(
    "click",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeArtistTracksPanel(item);
    },
    true
  );

  head.appendChild(title);
  head.appendChild(count);
  head.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "sd-artist-tracks-body";

  const status = document.createElement("div");
  status.className = "sd-artist-tracks-status";
  status.textContent = "Lädt…";

  const list = document.createElement("div");
  list.className = "sd-artist-tracks-list";

  body.appendChild(status);
  body.appendChild(list);
  panel.appendChild(head);
  panel.appendChild(body);

  item.insertAdjacentElement("afterend", panel);
  return panel;
}

function setArtistTracksButtonState(btn, isOpen, isLoading) {
  if (!btn) return;
  btn.classList.toggle("is-active", Boolean(isOpen));
  btn.classList.toggle("is-loading", Boolean(isLoading));
  btn.disabled = Boolean(isLoading);
}

function closeArtistTracksPanel(item) {
  const panel = getArtistTracksPanel(item);
  const btn = item ? item.querySelector(".sd-artist-tracks") : null;
  if (panel) stopPanelPreviewInRoot(panel);
  if (panel) panel.hidden = true;
  setArtistTracksButtonState(btn, false, false);
  if (openArtistPanelItem === item) openArtistPanelItem = null;
}

function closeOtherArtistPanels(exceptItem) {
  const panels = document.querySelectorAll(".sd-artist-tracks-panel:not([hidden])");
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    const trackId = panel.dataset.forTrackId;
    const owner = trackId ? findTrackItem(trackId) : null;
    if (owner && owner !== exceptItem) closeArtistTracksPanel(owner);
  }
}

async function openArtistTracksPanel(item, btn) {
  if (!item || dead) return;

  const panel = ensureArtistTracksPanel(item);
  const titleEl = panel.querySelector(".sd-artist-tracks-title");
  const countEl = panel.querySelector(".sd-artist-tracks-count");
  const statusEl = panel.querySelector(".sd-artist-tracks-status");
  const listEl = panel.querySelector(".sd-artist-tracks-list");
  const sourceTrackId = item.getAttribute("data-track-id");

  closeOtherArtistPanels(item);
  openArtistPanelItem = item;
  panel.hidden = false;
  setArtistTracksButtonState(btn, true, true);

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = "Lädt Artist…";
  }
  if (listEl) listEl.innerHTML = "";

  const token = ++artistTracksFetchToken;
  const info = await resolveArtistInfo(item);
  if (dead || token !== artistTracksFetchToken) return;

  if (!info) {
    if (statusEl) statusEl.textContent = "Artist nicht gefunden.";
    setArtistTracksButtonState(btn, true, false);
    return;
  }

  if (titleEl) titleEl.textContent = "Tracks by " + info.name;
  if (countEl) {
    if (info.trackCount != null) {
      countEl.textContent = String(info.trackCount);
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  if (statusEl) statusEl.textContent = "Lädt Tracks…";

  const firstPage = await loadArtistTracksHtml(info, sourceTrackId, info.url);
  if (dead || token !== artistTracksFetchToken) return;

  if (!firstPage || !firstPage.html) {
    if (statusEl) statusEl.textContent = "Keine Tracks gefunden.";
    setArtistTracksButtonState(btn, true, false);
    return;
  }

  let combinedHtml = firstPage.html;
  let nextUrl = firstPage.nextPageUrl;
  let pagesLoaded = 1;
  const maxPages = 5;

  while (nextUrl && pagesLoaded < maxPages && !dead && token === artistTracksFetchToken) {
    if (statusEl) statusEl.textContent = "Lädt Seite " + (pagesLoaded + 1) + "…";
    const nextPage = await loadArtistTracksHtml(info, sourceTrackId, nextUrl);
    if (!nextPage || !nextPage.html) break;
    combinedHtml += nextPage.html;
    nextUrl = nextPage.nextPageUrl;
    pagesLoaded += 1;
  }

  if (dead || token !== artistTracksFetchToken) return;

  if (listEl) listEl.innerHTML = combinedHtml;
  if (statusEl) statusEl.hidden = true;
  setArtistTracksButtonState(btn, true, false);
  scheduleApply();
}

function toggleArtistTracksPanel(item, btn) {
  const panel = getArtistTracksPanel(item);
  const isOpen = panel && !panel.hidden;
  if (isOpen) {
    closeArtistTracksPanel(item);
    return;
  }
  openArtistTracksPanel(item, btn);
}

function ensureArtistTracksButton(item, bar) {
  if (!item || !bar || dead) return;

  let btn = bar.querySelector(".sd-artist-tracks");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sd-artist-btn sd-artist-tracks";
    btn.title = "Weitere Tracks vom Artist";
    btn.setAttribute("aria-label", "Weitere Tracks vom Artist");
    btn.textContent = "♫";
    btn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleArtistTracksPanel(item, btn);
      },
      true
    );
    bar.appendChild(btn);
  }
}
