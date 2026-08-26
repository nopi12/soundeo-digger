const STORAGE_KEYS = {
  favorites: "favoriteGenres",
  selectedFavorites: "selectedFavoriteGenres",
  hideDownloaded: "hideDownloaded",
  hideListened: "hideListened",
  randomYears: "randomYears",
  blockedArtists: "blockedArtists",
  favoriteArtists: "favoriteArtists",
  scTitleFilter: "scTitleFilter"
};

const BASE_PARAMS = {
  artistFilter: "",
  labelFilter: "",
  bpmFilter: "0,260",
  keyFilter: "",
  trackTypeFilter: "0",
  topTimeFilter: "0"
};

function normalizeArtistKey(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function sanitizeArtistList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = String(item || "").trim().replace(/\s+/g, " ");
    const key = normalizeArtistKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function sanitizeTitleFilter(value) {
  return String(value || "").trim().slice(0, 120);
}

function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.2, Math.max(0.8, n));
}

function rateToOffset(rate) {
  return Math.round((clampRate(rate) - 1) * 100);
}

function formatOffset(offset) {
  if (offset > 0) return `+${offset}%`;
  return `${offset}%`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseYMD(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Monday of the week containing `date` (local). */
function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function weekRangeFromMonday(monday) {
  const start = startOfWeek(monday);
  const end = addDays(start, 7);
  return { start, end, filter: `r_${formatDate(start)}_${formatDate(end)}` };
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function monthRangeFromStart(start) {
  const monthStart = startOfMonth(start);
  const end = addMonths(monthStart, 1);
  return { start: monthStart, end, filter: `r_${formatDate(monthStart)}_${formatDate(end)}` };
}

function pickRandomMonthFilter(years) {
  const span = Math.max(1, Math.min(20, Number(years) || 3));
  const thisMonth = startOfMonth(new Date());
  const earliest = addMonths(thisMonth, -span * 12);
  const maxOffsetMonths =
    (thisMonth.getFullYear() - earliest.getFullYear()) * 12 +
    (thisMonth.getMonth() - earliest.getMonth());
  const offset = Math.floor(Math.random() * (maxOffsetMonths + 1));
  const randomMonthStart = addMonths(earliest, offset);
  return monthRangeFromStart(randomMonthStart).filter;
}

function parseTimeFilter(timeFilter) {
  if (!timeFilter || timeFilter === "7" || timeFilter === "0") {
    return weekRangeFromMonday(new Date());
  }
  const match = /^r_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(timeFilter);
  if (match) {
    return {
      start: parseYMD(match[1]),
      end: parseYMD(match[2]),
      filter: timeFilter
    };
  }
  return weekRangeFromMonday(new Date());
}

function labelForWeek(week) {
  const thisWeek = weekRangeFromMonday(new Date());
  if (week.filter === thisWeek.filter || formatDate(week.start) === formatDate(thisWeek.start)) {
    return "Diese Woche";
  }
  return `${formatDate(week.start)} → ${formatDate(addDays(week.end, -1))}`;
}

function buildTop100Url({ genreId = "", timeFilter = "7" } = {}) {
  const params = new URLSearchParams({
    ...BASE_PARAMS,
    genreFilter: genreId || "",
    timeFilter
  });
  return `https://soundeo.com/top100?${params.toString()}`;
}

function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "soundeo.com" || host.endsWith(".soundeo.com")) return "soundeo";
    if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) return "soundcloud";
  } catch {
    // ignore
  }
  return "idle";
}

function getStorage(keys) {
  return chrome.storage.sync.get(keys);
}

function setStorage(obj) {
  return chrome.storage.sync.set(obj);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function parseSoundeoState(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("soundeo.com")) return null;
    return {
      genreFilter: u.searchParams.get("genreFilter") || "",
      timeFilter: u.searchParams.get("timeFilter") || "7"
    };
  } catch {
    return null;
  }
}

async function navigateTo(url) {
  const tab = await getActiveTab();
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

function $(id) {
  return document.getElementById(id);
}

function showView(platform) {
  const idle = $("view-idle");
  const soundeo = $("view-soundeo");
  const soundcloud = $("view-soundcloud");
  const pill = $("platform-pill");
  const body = document.body;

  idle.hidden = platform !== "idle";
  soundeo.hidden = platform !== "soundeo";
  soundcloud.hidden = platform !== "soundcloud";

  body.dataset.platform = platform;
  if (platform === "soundeo") {
    pill.textContent = "Soundeo";
    pill.className = "platform-pill platform-soundeo";
  } else if (platform === "soundcloud") {
    pill.textContent = "SoundCloud";
    pill.className = "platform-pill platform-soundcloud";
  } else {
    pill.textContent = "—";
    pill.className = "platform-pill";
  }
}

const SOUNDEO_TAB_KEY = "soundeoActiveTab";

function setSoundeoTab(tabId) {
  const tabs = document.querySelectorAll("#view-soundeo .tab");
  const panels = document.querySelectorAll("#view-soundeo .tab-panel");

  for (const tab of tabs) {
    const active = tab.dataset.tab === tabId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }

  for (const panel of panels) {
    const active = panel.dataset.tab === tabId;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  }

  try {
    sessionStorage.setItem(SOUNDEO_TAB_KEY, tabId);
  } catch {
    // ignore
  }
}

function initSoundeoTabs() {
  const tabBar = document.querySelector("#view-soundeo .tab-bar");
  if (!tabBar || tabBar.dataset.wired) return;
  tabBar.dataset.wired = "1";

  let initial = "browse";
  try {
    const saved = sessionStorage.getItem(SOUNDEO_TAB_KEY);
    if (saved && tabBar.querySelector(`[data-tab="${saved}"]`)) {
      initial = saved;
    }
  } catch {
    // ignore
  }

  setSoundeoTab(initial);

  tabBar.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab?.dataset.tab) return;
    setSoundeoTab(tab.dataset.tab);
  });
}

function updateFilterTabBadge(favCount, blockCount) {
  const badge = $("filter-tab-badge");
  if (!badge) return;
  const total = favCount + blockCount;
  badge.textContent = String(total);
  badge.hidden = total === 0;
}

function createFavoriteChip(genre, { isActive, onSelect, onToggleFav }) {
  const chip = document.createElement("div");
  chip.className = `fav-chip${isActive ? " active" : ""}`;
  chip.title = genre.name;

  const star = document.createElement("button");
  star.type = "button";
  star.className = "fav-chip-star";
  star.title = "Aus Favoriten entfernen";
  star.textContent = "★";
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggleFav(genre.id);
  });

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fav-chip-btn";
  btn.textContent = genre.name;
  btn.addEventListener("click", () => onSelect(genre.id));

  chip.append(star, btn);
  return chip;
}

function createGenreItem(genre, { isFavorite, isActive, onSelect, onToggleFav }) {
  const row = document.createElement("div");
  row.className = `genre-item${isActive ? " active" : ""}${genre.id === "" ? " all-genres" : ""}`;
  row.dataset.id = genre.id;

  const favBtn = document.createElement("button");
  favBtn.type = "button";
  favBtn.className = `fav-btn${isFavorite ? " is-fav" : ""}`;
  favBtn.title = isFavorite ? "Aus Favoriten entfernen" : "Zu Favoriten";
  favBtn.textContent = isFavorite ? "★" : "☆";
  favBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggleFav(genre.id);
  });

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "genre-btn";
  btn.textContent = genre.name;
  btn.addEventListener("click", () => onSelect(genre.id));

  row.append(favBtn, btn);
  return row;
}

async function initSoundcloud(tab) {
  $("current-context").textContent = "Stream / Listen filtern";

  const stored = await getStorage([
    STORAGE_KEYS.scTitleFilter,
    STORAGE_KEYS.hideListened
  ]);
  let titleFilter = sanitizeTitleFilter(stored[STORAGE_KEYS.scTitleFilter]);
  let hideListened = Boolean(stored[STORAGE_KEYS.hideListened]);
  const local = await chrome.storage.local.get(["playbackRate"]);
  let playbackRate = clampRate(local.playbackRate);

  const filterInput = $("sc-title-filter");
  const filterBadge = $("sc-filter-badge");
  const clearBtn = $("btn-sc-filter-clear");
  const rateSlider = $("sc-rate-slider");
  const rateLabel = $("sc-rate-label");
  const rateReset = $("btn-sc-rate-reset");
  const hideListenedInput = $("sc-hide-listened");
  const playedCount = $("sc-played-count");
  const clearPlayedBtn = $("btn-sc-clear-played");

  function updateFilterUi(value) {
    titleFilter = sanitizeTitleFilter(value);
    if (filterInput.value !== titleFilter) filterInput.value = titleFilter;
    filterBadge.textContent = titleFilter ? "aktiv" : "aus";
  }

  function updateRateUi(rate) {
    playbackRate = clampRate(rate);
    const offset = rateToOffset(playbackRate);
    rateSlider.value = String(offset);
    rateLabel.textContent = formatOffset(offset);
  }

  updateFilterUi(titleFilter);
  updateRateUi(playbackRate);
  hideListenedInput.checked = hideListened;

  async function refreshPlayedCount() {
    const localPlayed = await chrome.storage.local.get(["playedTracks"]);
    const count = Object.keys(localPlayed.playedTracks || {}).length;
    playedCount.textContent = `${count} Play${count === 1 ? "" : "s"} gespeichert`;
  }

  async function notifyTab(type, value) {
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type, value });
    } catch {
      // Tab may not have content script yet
    }
  }

  async function persistFilter(next) {
    updateFilterUi(next);
    // Direct storage write + BG broadcast + tab ping (belt & suspenders)
    await chrome.storage.sync.set({ [STORAGE_KEYS.scTitleFilter]: titleFilter });
    try {
      await chrome.runtime.sendMessage({
        type: "BG_SET_SC_TITLE_FILTER",
        scTitleFilter: titleFilter
      });
    } catch {
      // ignore
    }
    await notifyTab("SET_SC_TITLE_FILTER", titleFilter);
    await notifyTab("SC_TITLE_FILTER_CHANGED", titleFilter);
    // Also send payload shape content script expects for SC_TITLE_FILTER_CHANGED
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "SC_TITLE_FILTER_CHANGED",
          scTitleFilter: titleFilter
        });
      } catch {
        // ignore
      }
    }
  }

  let filterTimer = null;
  filterInput.addEventListener("input", () => {
    updateFilterUi(filterInput.value);
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      persistFilter(filterInput.value);
    }, 120);
  });

  clearBtn.addEventListener("click", async () => {
    await persistFilter("");
  });

  rateSlider.addEventListener("input", async () => {
    const offset = Number(rateSlider.value) || 0;
    updateRateUi(1 + offset / 100);
    await chrome.runtime.sendMessage({
      type: "BG_SET_PLAYBACK_RATE",
      playbackRate
    });
  });

  rateReset.addEventListener("click", async () => {
    updateRateUi(1);
    await chrome.runtime.sendMessage({
      type: "BG_SET_PLAYBACK_RATE",
      playbackRate: 1
    });
  });

  hideListenedInput.addEventListener("change", async () => {
    hideListened = hideListenedInput.checked;
    await setStorage({ [STORAGE_KEYS.hideListened]: hideListened });
    await notifyTab("SET_HIDE_LISTENED", hideListened);
  });

  clearPlayedBtn.addEventListener("click", async () => {
    if (!confirm("Alle gespeicherten Plays löschen?")) return;
    await chrome.storage.local.set({ playedTracks: {} });
    await notifyTab("CLEAR_PLAYED", true);
    await refreshPlayedCount();
  });

  await refreshPlayedCount();
}

async function initSoundeo(tab) {
  const state = parseSoundeoState(tab?.url || "");
  const stored = await getStorage([
    STORAGE_KEYS.favorites,
    STORAGE_KEYS.hideDownloaded,
    STORAGE_KEYS.hideListened,
    STORAGE_KEYS.randomYears,
    STORAGE_KEYS.blockedArtists,
    STORAGE_KEYS.favoriteArtists
  ]);

  let favorites = stored[STORAGE_KEYS.favorites] || [];
  let hideDownloaded = Boolean(stored[STORAGE_KEYS.hideDownloaded]);
  let hideListened = Boolean(stored[STORAGE_KEYS.hideListened]);
  let randomYears = Number(stored[STORAGE_KEYS.randomYears]) || 3;
  let blockedArtists = sanitizeArtistList(stored[STORAGE_KEYS.blockedArtists]);
  let favoriteArtists = sanitizeArtistList(stored[STORAGE_KEYS.favoriteArtists]);
  let currentGenre = state?.genreFilter || "";
  let currentWeek = parseTimeFilter(state?.timeFilter);

  const els = {
    context: $("current-context"),
    weekLabel: $("week-label"),
    lastWeek: $("btn-last-week"),
    thisWeek: $("btn-this-week"),
    nextWeek: $("btn-next-week"),
    randomWeek: $("btn-random-week"),
    randomMonth: $("btn-random-month"),
    randomYears: $("random-years"),
    hideDownloaded: $("hide-downloaded"),
    hideListened: $("hide-listened"),
    playedCount: $("played-count"),
    clearPlayed: $("btn-clear-played"),
    artistFavList: $("artist-fav-list"),
    artistFavCount: $("artist-fav-count"),
    artistFavForm: $("artist-fav-form"),
    artistFavInput: $("artist-fav-input"),
    artistBlockList: $("artist-block-list"),
    artistBlockCount: $("artist-block-count"),
    artistBlockForm: $("artist-block-form"),
    artistBlockInput: $("artist-block-input"),
    favList: $("favorites-list"),
    favCount: $("fav-count"),
    genreList: $("genres-list"),
    search: $("genre-search")
  };

  els.randomYears.value = String(randomYears);
  els.hideDownloaded.checked = hideDownloaded;
  els.hideListened.checked = hideListened;

  async function refreshPlayedCount() {
    const local = await chrome.storage.local.get(["playedTracks"]);
    const count = Object.keys(local.playedTracks || {}).length;
    els.playedCount.textContent = `${count} Play${count === 1 ? "" : "s"} gespeichert`;
  }

  async function notifyTab(type, value) {
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type, value });
    } catch {
      // Tab may not have content script yet
    }
  }

  function updateContext() {
    const genre = GENRES.find((g) => g.id === currentGenre) || ALL_GENRES;
    els.context.textContent = `Top 100 · ${genre.name}`;
    els.weekLabel.textContent = labelForWeek(currentWeek);
  }

  function goWith({ genreId = currentGenre, timeFilter } = {}) {
    navigateTo(buildTop100Url({ genreId, timeFilter }));
  }

  async function persistArtists() {
    blockedArtists = sanitizeArtistList(blockedArtists);
    favoriteArtists = sanitizeArtistList(favoriteArtists);
    await chrome.runtime.sendMessage({
      type: "BG_SET_ARTISTS",
      blockedArtists,
      favoriteArtists
    });
    renderArtistLists();
  }

  function createArtistChip(name, kind) {
    const chip = document.createElement("div");
    chip.className = `artist-chip artist-chip-${kind}`;

    const label = document.createElement("span");
    label.className = "artist-chip-label";
    label.textContent = name;
    label.title = name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "artist-chip-remove";
    remove.title = "Entfernen";
    remove.textContent = "×";
    remove.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = normalizeArtistKey(name);
      if (kind === "fav") {
        favoriteArtists = favoriteArtists.filter(
          (n) => normalizeArtistKey(n) !== key
        );
      } else {
        blockedArtists = blockedArtists.filter(
          (n) => normalizeArtistKey(n) !== key
        );
      }
      await persistArtists();
    });

    chip.appendChild(label);
    chip.appendChild(remove);
    return chip;
  }

  function renderArtistChipList(el, countEl, names, kind, emptyText) {
    el.innerHTML = "";
    countEl.textContent = String(names.length);
    if (!names.length) {
      el.classList.add("empty");
      el.innerHTML = `<p class="empty-hint">${emptyText}</p>`;
      return;
    }
    el.classList.remove("empty");
    const sorted = [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    for (const name of sorted) {
      el.appendChild(createArtistChip(name, kind));
    }
  }

  function renderArtistLists() {
    renderArtistChipList(
      els.artistFavList,
      els.artistFavCount,
      favoriteArtists,
      "fav",
      "Noch keine Artist-Favoriten."
    );
    renderArtistChipList(
      els.artistBlockList,
      els.artistBlockCount,
      blockedArtists,
      "block",
      "Keine blockierten Artists."
    );
    updateFilterTabBadge(favoriteArtists.length, blockedArtists.length);
  }

  function addArtist(name, kind) {
    const display = String(name || "").trim().replace(/\s+/g, " ");
    const key = normalizeArtistKey(display);
    if (!key) return;
    if (kind === "fav") {
      favoriteArtists = sanitizeArtistList([...favoriteArtists, display]);
      blockedArtists = blockedArtists.filter(
        (n) => normalizeArtistKey(n) !== key
      );
    } else {
      blockedArtists = sanitizeArtistList([...blockedArtists, display]);
      favoriteArtists = favoriteArtists.filter(
        (n) => normalizeArtistKey(n) !== key
      );
    }
  }

  function renderFavorites() {
    els.favList.innerHTML = "";
    els.favCount.textContent = String(favorites.length);

    if (!favorites.length) {
      els.favList.classList.add("empty");
      els.favList.innerHTML =
        '<p class="empty-hint">Stern bei Genres tippen, um Favoriten zu speichern.</p>';
      return;
    }

    els.favList.classList.remove("empty");
    const favGenres = favorites
      .map((id) => GENRES.find((g) => g.id === id))
      .filter(Boolean);

    for (const genre of favGenres) {
      els.favList.appendChild(
        createFavoriteChip(genre, {
          isActive: genre.id === currentGenre,
          onSelect: (id) => goWith({ genreId: id, timeFilter: currentWeek.filter }),
          onToggleFav: toggleFavorite
        })
      );
    }
  }

  function renderGenres(filter = "") {
    const q = filter.trim().toLowerCase();
    els.genreList.innerHTML = "";

    const list = GENRES.filter((g) => !q || g.name.toLowerCase().includes(q));

    for (const genre of list) {
      els.genreList.appendChild(
        createGenreItem(genre, {
          isFavorite: favorites.includes(genre.id),
          isActive: genre.id === currentGenre,
          onSelect: (id) => goWith({ genreId: id, timeFilter: currentWeek.filter }),
          onToggleFav: toggleFavorite
        })
      );
    }
  }

  async function toggleFavorite(id) {
    const stored = await getStorage([STORAGE_KEYS.selectedFavorites]);
    let selected = stored[STORAGE_KEYS.selectedFavorites] || [];

    if (favorites.includes(id)) {
      favorites = favorites.filter((f) => f !== id);
      selected = selected.filter((f) => f !== id);
    } else {
      favorites = [...favorites, id];
      if (!selected.includes(id)) selected = [...selected, id];
    }

    await setStorage({
      [STORAGE_KEYS.favorites]: favorites,
      [STORAGE_KEYS.selectedFavorites]: selected
    });
    renderFavorites();
    renderGenres(els.search.value);
  }

  els.lastWeek.addEventListener("click", () => {
    const prev = weekRangeFromMonday(addDays(currentWeek.start, -7));
    goWith({ timeFilter: prev.filter });
  });

  els.nextWeek.addEventListener("click", () => {
    const next = weekRangeFromMonday(addDays(currentWeek.start, 7));
    const thisWeek = weekRangeFromMonday(new Date());
    if (next.start > thisWeek.start) {
      goWith({ timeFilter: "7" });
      return;
    }
    if (formatDate(next.start) === formatDate(thisWeek.start)) {
      goWith({ timeFilter: "7" });
      return;
    }
    goWith({ timeFilter: next.filter });
  });

  els.thisWeek.addEventListener("click", () => {
    goWith({ timeFilter: "7" });
  });

  els.randomWeek.addEventListener("click", () => {
    const years = Math.max(1, Math.min(20, Number(els.randomYears.value) || 3));
    const thisWeek = weekRangeFromMonday(new Date());
    const earliest = addDays(thisWeek.start, -years * 365);
    const earliestMonday = startOfWeek(earliest);

    const maxOffsetWeeks = Math.floor(
      (thisWeek.start - earliestMonday) / (7 * 24 * 60 * 60 * 1000)
    );
    const offset = Math.floor(Math.random() * (maxOffsetWeeks + 1));
    const randomMonday = addDays(earliestMonday, offset * 7);
    const week = weekRangeFromMonday(randomMonday);

    if (formatDate(week.start) === formatDate(thisWeek.start)) {
      goWith({ timeFilter: "7" });
    } else {
      goWith({ timeFilter: week.filter });
    }
  });

  els.randomMonth.addEventListener("click", () => {
    const years = Math.max(1, Math.min(20, Number(els.randomYears.value) || 3));
    goWith({ timeFilter: pickRandomMonthFilter(years) });
  });

  els.randomYears.addEventListener("change", async () => {
    randomYears = Math.max(1, Math.min(20, Number(els.randomYears.value) || 3));
    els.randomYears.value = String(randomYears);
    await setStorage({ [STORAGE_KEYS.randomYears]: randomYears });
  });

  els.hideDownloaded.addEventListener("change", async () => {
    hideDownloaded = els.hideDownloaded.checked;
    await setStorage({ [STORAGE_KEYS.hideDownloaded]: hideDownloaded });
    await notifyTab("SET_HIDE_DOWNLOADED", hideDownloaded);
  });

  els.hideListened.addEventListener("change", async () => {
    hideListened = els.hideListened.checked;
    await setStorage({ [STORAGE_KEYS.hideListened]: hideListened });
    await notifyTab("SET_HIDE_LISTENED", hideListened);
  });

  els.artistFavForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    addArtist(els.artistFavInput.value, "fav");
    els.artistFavInput.value = "";
    await persistArtists();
  });

  els.artistBlockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    addArtist(els.artistBlockInput.value, "block");
    els.artistBlockInput.value = "";
    await persistArtists();
  });

  els.clearPlayed.addEventListener("click", async () => {
    if (!confirm("Alle selbst getrackten Plays löschen?")) return;
    await chrome.storage.local.set({ playedTracks: {} });
    await notifyTab("CLEAR_PLAYED", true);
    await refreshPlayedCount();
  });

  await refreshPlayedCount();

  els.search.addEventListener("input", () => {
    renderGenres(els.search.value);
  });

  updateContext();
  initSoundeoTabs();
  renderArtistLists();
  renderFavorites();
  renderGenres();
}

async function initIdle() {
  $("current-context").textContent = "Öffne Soundeo oder SoundCloud";
  $("btn-open-soundeo").addEventListener("click", () => {
    navigateTo("https://soundeo.com/top100");
  });
  $("btn-open-soundcloud").addEventListener("click", () => {
    navigateTo("https://soundcloud.com/discover");
  });
}

async function init() {
  const tab = await getActiveTab();
  const platform = detectPlatform(tab?.url || "");
  showView(platform);

  if (platform === "soundeo") {
    await initSoundeo(tab);
    return;
  }
  if (platform === "soundcloud") {
    await initSoundcloud(tab);
    return;
  }
  await initIdle();
}

init();
