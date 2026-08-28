# Digger

Chrome-Extension (MV3) zum schnelleren Diggen auf [Soundeo](https://soundeo.com) und [SoundCloud](https://soundcloud.com).

**Idee:** Diggen auf der Seite, Defaults & Sync im Popup — eine Sprache (DE), drei Track-Zustände: **Gehört · Vormerken · Bewertung**.

## Struktur

```
shared/                  # Sync, Match-Modal, Sanitize, Rating, Logging
platforms/soundeo/       # Charts, Artists, Target-BPM, Overlay
platforms/soundcloud/    # Feed-Leiste, Tempo, Filter, Plays, Auto-Nachladen
background.js            # Storage + Broadcast + Geräte-Sync
popup.*                  # Setup & Status (tababhängig)
```

## Features

### Gemeinsam
- **Geräte-Sync** – Gehört / Vormerken / Ratings geräteübergreifend (Key unter „Gerät verknüpfen“)
- **Gehört** – Abspielen markiert Tracks; optional ausblenden
- **Vormerken** – Später laden (Soundeo ⬇ vs. ↓ WAV-Download)
- **Bewertung** – Score aus Hörverhalten (Tooltip am Stern)
- **Match-Dialog** – Unklare Cross-Platform-Treffer bestätigen; „Nicht mehr fragen“ möglich

### Soundeo (Popup + Overlay)
- Genre-Wechsel & Favoriten, Wochen-Navigation, Zufällige Woche/Monat
- Heruntergeladene / Gehörte ausblenden, Artists favorisieren / blockieren
- Preview-BPM (80–160) mit Re-Pitch im Seiten-Overlay

### SoundCloud (Seiten-Leiste)
- Titel-Filter, relatives Tempo (±20 %), Gehörte ausblenden
- Plays-Filter (Min/Max), „Nur anzeigen“ (Sets / Tracks / Free DL) — **nur auf `/feed`**
- Auto-Nachladen im Feed
- Perf-Panel nur mit `localStorage.diggerDebug = "1"` oder `?diggerDebug=1`

## Installation (unpacked)

1. Chrome → `chrome://extensions`
2. **Entwicklermodus** aktivieren
3. **Entpackte Erweiterung laden** → diesen Ordner
4. Nach Updates: Extension neu laden

## Nutzung

1. Tab auf `soundeo.com` oder `soundcloud.com` öffnen
2. Dig-Steuerung auf der Seite; Popup für Sync, Genres, Filter-Defaults
3. Zweites Gerät: Sync-Key unter Geräte-Sync → „Gerät verknüpfen“ kopieren/einfügen

## Soundeo URL-Logik

```
https://soundeo.com/top100?genreFilter=91&timeFilter=7&...
https://soundeo.com/top100?genreFilter=37&timeFilter=r_2026-07-06_2026-07-13&...
```

- `timeFilter=7` = aktuelle Woche
- `timeFilter=r_YYYY-MM-DD_YYYY-MM-DD` = konkrete Woche (Mo–Mo) oder Kalendermonat (1.–1.)
