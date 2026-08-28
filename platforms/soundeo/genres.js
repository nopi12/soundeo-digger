function padDate(n) {
  return String(n).padStart(2, "0");
}

function formatDateYmd(date) {
  return (
    date.getFullYear() +
    "-" +
    padDate(date.getMonth() + 1) +
    "-" +
    padDate(date.getDate())
  );
}

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
  return {
    start: start,
    end: end,
    filter: "r_" + formatDateYmd(start) + "_" + formatDateYmd(end)
  };
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
  return {
    start: monthStart,
    end: end,
    filter: "r_" + formatDateYmd(monthStart) + "_" + formatDateYmd(end)
  };
}

function pickRandomWeekFilter(years) {
  const span = Math.max(1, Math.min(20, Number(years) || 3));
  const thisWeek = weekRangeFromMonday(new Date());
  const earliest = addDays(thisWeek.start, -span * 365);
  const earliestMonday = startOfWeek(earliest);
  const maxOffsetWeeks = Math.floor(
    (thisWeek.start - earliestMonday) / (7 * 24 * 60 * 60 * 1000)
  );
  const offset = Math.floor(Math.random() * (maxOffsetWeeks + 1));
  const randomMonday = addDays(earliestMonday, offset * 7);
  const week = weekRangeFromMonday(randomMonday);
  if (formatDateYmd(week.start) === formatDateYmd(thisWeek.start)) return "7";
  return week.filter;
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

function genresCatalog() {
  return globalThis.GENRES || (typeof GENRES !== "undefined" ? GENRES : []);
}

function getGenreById(id) {
  const catalog = genresCatalog();
  for (let i = 0; i < catalog.length; i++) {
    if (catalog[i].id === id) return catalog[i];
  }
  return null;
}

function sanitizeFavoriteGenres(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const id = String(list[i] || "");
    if (!id || seen.has(id) || !getGenreById(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitizeSelectedFavoriteGenres(selected, favorites) {
  const favSet = new Set(favorites);
  if (!Array.isArray(selected)) return favorites.slice();
  return selected.filter(function (id) {
    return favSet.has(id);
  });
}

function shortGenreName(name) {
  const text = String(name || "");
  if (text.length <= 16) return text;
  return text.slice(0, 14) + "…";
}

function getCurrentGenreFilter() {
  try {
    return new URL(location.href).searchParams.get("genreFilter") || "";
  } catch (_) {
    return "";
  }
}

function getActiveSelectedGenres() {
  return state.selectedFavoriteGenres.filter(function (id) {
    return state.favoriteGenres.includes(id);
  });
}

function buildActiveGenreFilter() {
  const active = getActiveSelectedGenres();
  if (active.length) return active.join(",");
  return getCurrentGenreFilter();
}

function genreNameForFilter(genreFilter) {
  const raw = String(genreFilter || "").trim();
  if (!raw) return "All Genres";
  const ids = raw.split(",").map(function (s) {
    return s.trim();
  }).filter(Boolean);
  if (ids.length === 1) {
    const genre = getGenreById(ids[0]);
    return genre ? genre.name : "All Genres";
  }
  if (ids.length > 1) return ids.length + " Genres";
  return "All Genres";
}

function setSelectedFavoriteGenres(list, persist) {
  state.selectedFavoriteGenres = sanitizeSelectedFavoriteGenres(
    list,
    state.favoriteGenres
  );
  renderOverlayGenres();
  if (!persist || dead) return;
  clearTimeout(genreSaveTimer);
  genreSaveTimer = setTimeout(function () {
    chrome.storage.sync.set({
      selectedFavoriteGenres: state.selectedFavoriteGenres
    });
  }, 120);
}

function toggleSelectedGenre(id) {
  const selected = state.selectedFavoriteGenres.slice();
  const idx = selected.indexOf(id);
  if (idx >= 0) selected.splice(idx, 1);
  else selected.push(id);
  setSelectedFavoriteGenres(selected, true);
}

function selectAllFavoriteGenres() {
  setSelectedFavoriteGenres(state.favoriteGenres.slice(), true);
}

function selectNoFavoriteGenres() {
  setSelectedFavoriteGenres([], true);
}

function applyFavoriteGenres(favorites, selected) {
  state.favoriteGenres = sanitizeFavoriteGenres(favorites);
  state.selectedFavoriteGenres = sanitizeSelectedFavoriteGenres(
    selected != null ? selected : state.selectedFavoriteGenres,
    state.favoriteGenres
  );
  renderOverlayGenres();
}

async function loadGenrePreferences() {
  const data = await chrome.storage.sync.get([
    "favoriteGenres",
    "selectedFavoriteGenres"
  ]);
  const favorites = sanitizeFavoriteGenres(data.favoriteGenres);
  let selected = [];
  if (Array.isArray(data.selectedFavoriteGenres)) {
    selected = sanitizeSelectedFavoriteGenres(
      data.selectedFavoriteGenres,
      favorites
    );
  } else if (favorites.length) {
    selected = favorites.slice();
    await chrome.storage.sync.set({ selectedFavoriteGenres: selected });
  }
  state.favoriteGenres = favorites;
  state.selectedFavoriteGenres = selected;
  renderOverlayGenres();
}

function renderOverlayGenres() {
  if (!tempoUi || !tempoUi.genreRow) return;
  const row = tempoUi.genreRow;
  row.replaceChildren();

  const hasFavorites = state.favoriteGenres.length > 0;
  if (tempoUi.genreSection) tempoUi.genreSection.hidden = !hasFavorites;
  if (!hasFavorites) return;

  const activeCount = state.selectedFavoriteGenres.filter(function (id) {
    return state.favoriteGenres.includes(id);
  }).length;

  if (tempoUi.genreCount) {
    tempoUi.genreCount.textContent =
      activeCount + "/" + state.favoriteGenres.length + " aktiv";
  }

  for (let i = 0; i < state.favoriteGenres.length; i++) {
    const id = state.favoriteGenres[i];
    const genre = getGenreById(id);
    if (!genre) continue;

    const active = state.selectedFavoriteGenres.includes(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sd-genre-chip" + (active ? " is-active" : "");
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.textContent = genre.name;
    btn.title = active
      ? genre.name + " · aktiv im Filter (Klick = aus)"
      : genre.name + " · inaktiv (Klick = an)";
    btn.dataset.genreId = id;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelectedGenre(id);
    });
    row.appendChild(btn);
  }
}

function buildTop100UrlWithTimeFilter(timeFilter, genreFilter) {
  const params = new URLSearchParams({
    artistFilter: "",
    labelFilter: "",
    genreFilter: genreFilter != null ? genreFilter : getCurrentGenreFilter(),
    timeFilter: timeFilter,
    bpmFilter: "0,260",
    keyFilter: "",
    trackTypeFilter: "0",
    topTimeFilter: "0"
  });
  return "https://soundeo.com/top100?" + params.toString();
}

function goRandomWeek() {
  if (dead) return;
  const timeFilter = pickRandomWeekFilter(state.randomYears);
  const genreFilter = buildActiveGenreFilter();
  const url = buildTop100UrlWithTimeFilter(timeFilter, genreFilter);
  if (tempoUi && tempoUi.meta) {
    tempoUi.meta.textContent = "Zufällige Woche · " + shortGenreName(genreNameForFilter(genreFilter));
  }
  window.location.assign(url);
}

function goRandomMonth() {
  if (dead) return;
  const timeFilter = pickRandomMonthFilter(state.randomYears);
  const genreFilter = buildActiveGenreFilter();
  const url = buildTop100UrlWithTimeFilter(timeFilter, genreFilter);
  if (tempoUi && tempoUi.meta) {
    tempoUi.meta.textContent = "Zufälliger Monat · " + shortGenreName(genreNameForFilter(genreFilter));
  }
  window.location.assign(url);
}
