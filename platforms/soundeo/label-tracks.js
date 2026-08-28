const labelInfoCache = new Map();
const labelTracksCache = new Map();
let openLabelPanelItem = null;
let labelTracksFetchToken = 0;

function parseLabelFilterFromHref(href) {
  if (!href) return null;
  const match = String(href).match(/[?&]labelFilter=(\d+)/);
  return match ? match[1] : null;
}

function parseLabelLink(link) {
  if (!link) return null;
  const href = link.getAttribute("href") || "";
  const labelId = parseLabelFilterFromHref(href);
  if (!labelId) return null;

  const name = String(link.textContent || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!name) return null;

  const url = absoluteUrl(href);
  if (!url) return null;

  return {
    href: href,
    url: url,
    name: name,
    labelId: labelId,
    releaseCount: null
  };
}

function parseLabelInfoFromItem(item) {
  if (!item) return null;
  const links = item.querySelectorAll('.info span a[href*="labelFilter="]');
  for (let i = 0; i < links.length; i++) {
    const info = parseLabelLink(links[i]);
    if (info) return info;
  }
  return null;
}

function parseLabelInfoFromTrackHtml(html) {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const links = doc.querySelectorAll('a[href*="labelFilter="]');
  for (let i = 0; i < links.length; i++) {
    const info = parseLabelLink(links[i]);
    if (info) return info;
  }
  return null;
}

function parseLabelCountFromListHtml(html) {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const headings = doc.querySelectorAll(".left h1.line, .left h1");
  for (let i = 0; i < headings.length; i++) {
    const sup = headings[i].querySelector("sup");
    if (!sup) continue;
    const countText = String(sup.textContent || "").trim();
    if (/^\d+$/.test(countText)) return Number(countText);
  }
  return null;
}

function isLabelListNode(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.matches("h1, .folder")) return true;
  if (node.classList.contains("trackitem")) return true;
  if (node.classList.contains("releaseitem")) return true;
  if (node.hasAttribute("data-release-id")) return true;
  return false;
}

function parseLabelListPage(html, sourceTrackId) {
  if (!html) return { html: "", nextPageUrl: null, releaseCount: null };

  const doc = new DOMParser().parseFromString(html, "text/html");
  const left = doc.querySelector(".left");
  if (!left) return { html: "", nextPageUrl: null, releaseCount: null };

  const chunks = [];
  const nodes = left.children;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!isLabelListNode(node)) continue;
    if (node.classList.contains("trackitem")) {
      const id = node.getAttribute("data-track-id");
      if (sourceTrackId && id === String(sourceTrackId)) continue;
    }
    chunks.push(node.outerHTML);
  }

  let nextPageUrl = null;
  const pagination = doc.querySelector(".pagination");
  if (pagination) {
    const active = pagination.querySelector("li.active");
    let nextLink = null;
    if (active && active.nextElementSibling) {
      nextLink = active.nextElementSibling.querySelector("a[href]");
    }
    if (nextLink) {
      nextPageUrl = absoluteUrl(nextLink.getAttribute("href"));
    }
  }

  return {
    html: chunks.join("\n"),
    nextPageUrl: nextPageUrl,
    releaseCount: parseLabelCountFromListHtml(html)
  };
}

async function resolveLabelInfo(item) {
  const trackId = item ? item.getAttribute("data-track-id") : null;
  if (trackId && labelInfoCache.has(String(trackId))) {
    return labelInfoCache.get(String(trackId));
  }

  let info = parseLabelInfoFromItem(item);
  if (!info) {
    const trackUrl = getTrackUrl(item);
    if (!trackUrl) return null;
    const html = await fetchHtml(trackUrl);
    if (!html || dead) return null;
    info = parseLabelInfoFromTrackHtml(html);
  }

  if (!info) return null;

  if (trackId) labelInfoCache.set(String(trackId), info);
  if (info.labelId) labelInfoCache.set("label:" + info.labelId, info);
  return info;
}

async function loadLabelListHtml(info, sourceTrackId, pageUrl) {
  const cacheKey =
    (info.labelId ? "label:" + info.labelId : info.url) + "|" + (pageUrl || info.url);
  if (labelTracksCache.has(cacheKey)) {
    return labelTracksCache.get(cacheKey);
  }

  const html = await fetchHtml(pageUrl || info.url);
  if (!html || dead) return null;

  const parsed = parseLabelListPage(html, sourceTrackId);
  labelTracksCache.set(cacheKey, parsed);
  return parsed;
}

function getLabelTracksPanel(item) {
  if (!item) return null;
  let panel = item.nextElementSibling;
  if (panel && panel.classList.contains("sd-label-tracks-panel")) return panel;

  panel = item.parentNode
    ? item.parentNode.querySelector(
        '.sd-label-tracks-panel[data-for-track-id="' + item.getAttribute("data-track-id") + '"]'
      )
    : null;
  return panel || null;
}

function ensureLabelTracksPanel(item) {
  let panel = getLabelTracksPanel(item);
  if (panel) return panel;

  panel = document.createElement("div");
  panel.className = "sd-label-tracks-panel";
  panel.hidden = true;
  panel.dataset.forTrackId = item.getAttribute("data-track-id") || "";

  const head = document.createElement("div");
  head.className = "sd-label-tracks-head";

  const title = document.createElement("span");
  title.className = "sd-label-tracks-title";
  title.textContent = "Label-Releases";

  const count = document.createElement("sup");
  count.className = "sd-label-tracks-count";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "sd-label-tracks-close";
  closeBtn.title = "Schließen";
  closeBtn.setAttribute("aria-label", "Schließen");
  closeBtn.textContent = "×";
  closeBtn.addEventListener(
    "click",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeLabelTracksPanel(item);
    },
    true
  );

  head.appendChild(title);
  head.appendChild(count);
  head.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "sd-label-tracks-body";

  const status = document.createElement("div");
  status.className = "sd-label-tracks-status";
  status.textContent = "Lädt…";

  const list = document.createElement("div");
  list.className = "sd-label-tracks-list";

  body.appendChild(status);
  body.appendChild(list);
  panel.appendChild(head);
  panel.appendChild(body);

  item.insertAdjacentElement("afterend", panel);
  return panel;
}

function setLabelTracksButtonState(btn, isOpen, isLoading) {
  if (!btn) return;
  btn.classList.toggle("is-active", Boolean(isOpen));
  btn.classList.toggle("is-loading", Boolean(isLoading));
  btn.disabled = Boolean(isLoading);
}

function closeLabelTracksPanel(item) {
  const panel = getLabelTracksPanel(item);
  const btn = item ? item.querySelector(".sd-label-tracks") : null;
  if (panel) stopPanelPreviewInRoot(panel);
  if (panel) panel.hidden = true;
  setLabelTracksButtonState(btn, false, false);
  if (openLabelPanelItem === item) openLabelPanelItem = null;
}

function closeOtherLabelPanels(exceptItem) {
  const panels = document.querySelectorAll(".sd-label-tracks-panel:not([hidden])");
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    const trackId = panel.dataset.forTrackId;
    const owner = trackId ? findTrackItem(trackId) : null;
    if (owner && owner !== exceptItem) closeLabelTracksPanel(owner);
  }
}

async function openLabelTracksPanel(item, btn) {
  if (!item || dead) return;

  const panel = ensureLabelTracksPanel(item);
  const titleEl = panel.querySelector(".sd-label-tracks-title");
  const countEl = panel.querySelector(".sd-label-tracks-count");
  const statusEl = panel.querySelector(".sd-label-tracks-status");
  const listEl = panel.querySelector(".sd-label-tracks-list");
  const sourceTrackId = item.getAttribute("data-track-id");

  closeOtherLabelPanels(item);
  openLabelPanelItem = item;
  panel.hidden = false;
  setLabelTracksButtonState(btn, true, true);

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = "Lädt Label…";
  }
  if (listEl) listEl.innerHTML = "";

  const token = ++labelTracksFetchToken;
  const info = await resolveLabelInfo(item);
  if (dead || token !== labelTracksFetchToken) return;

  if (!info) {
    if (statusEl) statusEl.textContent = "Label nicht gefunden.";
    setLabelTracksButtonState(btn, true, false);
    return;
  }

  if (titleEl) titleEl.textContent = "Releases von " + info.name;
  if (countEl) countEl.hidden = true;

  if (statusEl) statusEl.textContent = "Lädt Releases…";

  const firstPage = await loadLabelListHtml(info, sourceTrackId, info.url);
  if (dead || token !== labelTracksFetchToken) return;

  if (!firstPage || !firstPage.html) {
    if (statusEl) statusEl.textContent = "Keine Releases gefunden.";
    setLabelTracksButtonState(btn, true, false);
    return;
  }

  let combinedHtml = firstPage.html;
  let nextUrl = firstPage.nextPageUrl;
  let pagesLoaded = 1;
  const maxPages = 5;
  let releaseCount = firstPage.releaseCount;

  while (nextUrl && pagesLoaded < maxPages && !dead && token === labelTracksFetchToken) {
    if (statusEl) statusEl.textContent = "Lädt Seite " + (pagesLoaded + 1) + "…";
    const nextPage = await loadLabelListHtml(info, sourceTrackId, nextUrl);
    if (!nextPage || !nextPage.html) break;
    combinedHtml += nextPage.html;
    if (nextPage.releaseCount != null) releaseCount = nextPage.releaseCount;
    nextUrl = nextPage.nextPageUrl;
    pagesLoaded += 1;
  }

  if (dead || token !== labelTracksFetchToken) return;

  if (countEl) {
    if (releaseCount != null) {
      countEl.textContent = String(releaseCount);
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  if (listEl) listEl.innerHTML = combinedHtml;
  if (statusEl) statusEl.hidden = true;
  setLabelTracksButtonState(btn, true, false);
  scheduleApply();
}

function toggleLabelTracksPanel(item, btn) {
  const panel = getLabelTracksPanel(item);
  const isOpen = panel && !panel.hidden;
  if (isOpen) {
    closeLabelTracksPanel(item);
    return;
  }
  openLabelTracksPanel(item, btn);
}

function ensureLabelTracksButton(item, bar) {
  if (!item || !bar || dead) return;

  let btn = bar.querySelector(".sd-label-tracks");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sd-artist-btn sd-label-tracks";
    btn.title = "Weitere Releases vom Label";
    btn.setAttribute("aria-label", "Weitere Releases vom Label");
    btn.textContent = "Label";
    btn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleLabelTracksPanel(item, btn);
      },
      true
    );
    bar.appendChild(btn);
  }
  btn.textContent = "Label";
}
