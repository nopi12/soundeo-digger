const STORAGE_KEYS = {
  favorites: "favoriteGenres",
  selectedFavorites: "selectedFavoriteGenres",
  hideDownloaded: "hideDownloaded",
  hideListened: "hideListened",
  randomYears: "randomYears",
  blockedArtists: "blockedArtists",
  favoriteArtists: "favoriteArtists",
  scTitleFilter: "scTitleFilter",
  skipMatchPrompts: "diggerSkipMatchPrompts",
  matchMinScore: "diggerMatchMinScore"
};

const BASE_PARAMS = {
  artistFilter: "",
  labelFilter: "",
  bpmFilter: "0,260",
  keyFilter: "",
  trackTypeFilter: "0",
  topTimeFilter: "0"
};

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
  const legend = $("dig-legend");
  const body = document.body;

  idle.hidden = platform !== "idle";
  soundeo.hidden = platform !== "soundeo";
  soundcloud.hidden = platform !== "soundcloud";
  if (legend) legend.hidden = platform === "idle";

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
  $("current-context").textContent = "Diggen auf der Seite";

  const stored = await getStorage([
    STORAGE_KEYS.scTitleFilter,
    STORAGE_KEYS.hideListened,
    STORAGE_KEYS.skipMatchPrompts,
    STORAGE_KEYS.matchMinScore
  ]);
  let hideListened = Boolean(stored[STORAGE_KEYS.hideListened]);
  const titleFilter = sanitizeTitleFilter(stored[STORAGE_KEYS.scTitleFilter]);
  const local = await chrome.storage.local.get(["playbackRate"]);
  const playbackRate = clampRate(local.playbackRate);

  const filterStatus = $("sc-status-filter");
  const rateStatus = $("sc-status-rate");
  const playedCount = $("sc-played-count");
  const hideListenedInput = $("sc-hide-listened");
  const clearPlayedBtn = $("btn-sc-clear-played");
  const skipMatchInput = $("sc-skip-match-prompts");
  const matchMinScoreSelect = $("sc-match-min-score");

  if (filterStatus) {
    filterStatus.textContent = titleFilter ? `„${titleFilter}"` : "aus";
  }
  if (rateStatus) {
    rateStatus.textContent = formatOffset(rateToOffset(playbackRate));
  }
  if (hideListenedInput) hideListenedInput.checked = hideListened;
  if (skipMatchInput) {
    skipMatchInput.checked = Boolean(stored[STORAGE_KEYS.skipMatchPrompts]);
  }
  if (matchMinScoreSelect) {
    const score = String(sanitizeMatchMinScore(stored[STORAGE_KEYS.matchMinScore]));
    matchMinScoreSelect.value = ["0", "0.6", "0.75", "0.85"].includes(score)
      ? score
      : "0";
  }

  async function refreshPlayedCount() {
    const localPlayed = await chrome.storage.local.get(["playedTracks"]);
    const count = Object.keys(localPlayed.playedTracks || {}).length;
    if (playedCount) {
      playedCount.textContent = count === 1 ? "1 Track" : `${count} Tracks`;
    }
  }

  async function notifyTab(type, value) {
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type, value });
    } catch {
      // Tab may not have content script yet
    }
  }

  if (hideListenedInput) {
    hideListenedInput.addEventListener("change", async () => {
      hideListened = hideListenedInput.checked;
      await setStorage({ [STORAGE_KEYS.hideListened]: hideListened });
      await notifyTab("SET_HIDE_LISTENED", hideListened);
    });
  }

  if (skipMatchInput) {
    skipMatchInput.addEventListener("change", async () => {
      await setStorage({
        [STORAGE_KEYS.skipMatchPrompts]: skipMatchInput.checked
      });
    });
  }

  if (matchMinScoreSelect) {
    matchMinScoreSelect.addEventListener("change", async () => {
      await setStorage({
        [STORAGE_KEYS.matchMinScore]: sanitizeMatchMinScore(matchMinScoreSelect.value)
      });
    });
  }

  if (clearPlayedBtn) {
    clearPlayedBtn.addEventListener("click", async () => {
      if (!confirm("Alle gehörten Tracks löschen?")) return;
      await chrome.runtime.sendMessage({ type: "BG_CLEAR_PLAYED" });
      await notifyTab("CLEAR_PLAYED", true);
      await refreshPlayedCount();
    });
  }

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
    STORAGE_KEYS.favoriteArtists,
    STORAGE_KEYS.skipMatchPrompts,
    STORAGE_KEYS.matchMinScore
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
    skipMatchPrompts: $("skip-match-prompts"),
    matchMinScore: $("match-min-score"),
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
  if (els.skipMatchPrompts) {
    els.skipMatchPrompts.checked = Boolean(stored[STORAGE_KEYS.skipMatchPrompts]);
  }
  if (els.matchMinScore) {
    const score = String(sanitizeMatchMinScore(stored[STORAGE_KEYS.matchMinScore]));
    els.matchMinScore.value = ["0", "0.6", "0.75", "0.85"].includes(score)
      ? score
      : "0";
  }

  async function refreshPlayedCount() {
    const local = await chrome.storage.local.get(["playedTracks"]);
    const count = Object.keys(local.playedTracks || {}).length;
    els.playedCount.textContent =
      count === 1 ? "1 gehört" : `${count} gehört`;
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

  if (els.skipMatchPrompts) {
    els.skipMatchPrompts.addEventListener("change", async () => {
      await setStorage({
        [STORAGE_KEYS.skipMatchPrompts]: els.skipMatchPrompts.checked
      });
    });
  }

  if (els.matchMinScore) {
    els.matchMinScore.addEventListener("change", async () => {
      await setStorage({
        [STORAGE_KEYS.matchMinScore]: sanitizeMatchMinScore(els.matchMinScore.value)
      });
    });
  }

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
    if (!confirm("Alle gehörten Tracks löschen?")) return;
    await chrome.runtime.sendMessage({ type: "BG_CLEAR_PLAYED" });
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

async function refreshSyncUi() {
  const badge = $("sync-badge");
  const hint = $("sync-hint");
  const keyInput = $("sync-key");
  const section = $("sync-section");
  if (!badge || !keyInput) return;
  try {
    const info = await chrome.runtime.sendMessage({ type: "BG_SYNC_INFO" });
    if (!info || !info.ok) {
      badge.textContent = "offline";
      if (section) section.classList.remove("is-connected");
      if (hint) hint.textContent = (info && info.error) || "Sync nicht erreichbar.";
      return;
    }
    keyInput.value = info.apiKey || "";
    const st = info.status || {};
    if (st.ok === false) {
      badge.textContent = "Fehler";
      if (section) section.classList.remove("is-connected");
      if (hint) hint.textContent = st.lastError || "Sync-Fehler — später erneut versuchen.";
    } else {
      const remote = st.remoteCount != null ? st.remoteCount : "—";
      const q = info.queueLength || 0;
      badge.textContent = q ? `verbunden · ${q} wartend` : "verbunden";
      if (section) section.classList.toggle("is-connected", !q);
      if (hint) {
        const wants = info.wantCount != null ? info.wantCount : 0;
        hint.textContent =
          `${remote} gehört · ${wants} vorgemerkt` +
          (q ? ` · ${q} in Warteschlange` : "") +
          " — Key unter „Gerät verknüpfen“.";
      }
    }
  } catch (err) {
    badge.textContent = "offline";
    if (section) section.classList.remove("is-connected");
    if (hint) hint.textContent = String(err.message || err);
  }
}

async function initSyncUi() {
  const copyBtn = $("btn-sync-copy");
  const syncNowBtn = $("btn-sync-now");
  const form = $("sync-link-form");
  const keyField = $("sync-key-input");

  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const key = $("sync-key")?.value || "";
      if (!key) return;
      try {
        await navigator.clipboard.writeText(key);
        copyBtn.textContent = "Kopiert";
        setTimeout(() => {
          copyBtn.textContent = "Kopieren";
        }, 1200);
      } catch {
        // Clipboard may be blocked in popup context
      }
    });
  }

  if (syncNowBtn) {
    syncNowBtn.addEventListener("click", async () => {
      syncNowBtn.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type: "BG_SYNC_NOW" });
      } finally {
        syncNowBtn.disabled = false;
        await refreshSyncUi();
      }
    });
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const apiKey = (keyField?.value || "").trim();
      if (!apiKey) return;
      const res = await chrome.runtime.sendMessage({
        type: "BG_SYNC_LINK",
        apiKey
      });
      if (!res || !res.ok) {
        alert((res && res.error) || "Verknüpfen fehlgeschlagen");
        return;
      }
      if (keyField) keyField.value = "";
      await refreshSyncUi();
    });
  }

  await refreshSyncUi();
}

async function init() {
  const tab = await getActiveTab();
  const platform = detectPlatform(tab?.url || "");
  showView(platform);
  await initSyncUi();

  if (window.DiggerOnboarding) {
    window.DiggerOnboarding.show("popup", { popup: true });
  }

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
