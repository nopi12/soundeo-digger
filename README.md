# Digger

Chrome Extension zum schnelleren Diggen auf [Soundeo](https://soundeo.com) und [SoundCloud](https://soundcloud.com).

Das Popup zeigt je nach aktivem Tab die passende Platform-View.

## Struktur

```
shared/page-hook.js          # playbackRate-Hook (MAIN world)
platforms/soundeo/           # Charts, Artists, Target-BPM, Filters
platforms/soundcloud/        # Relatives Tempo + Titel-Filter
background.js                # Storage + Broadcast
popup.*                      # Tab-abhängige UI
```

## Features

### Soundeo
- **Genre-Wechsel** – All Genres oder einzelnes Genre → Top 100 Charts
- **Favoriten** – Genres mit ★ merken (sync über Chrome-Profil)
- **Woche navigieren** – Last Week / This Week / Next Week
- **Random Week / Random Month** – Zufällige Woche oder Kalendermonat aus den letzten X Jahren
- **Downloads / Plays ausblenden**
- **Preview-BPM** – Ziel-BPM (80–160) mit Re-Pitch (±20 %)
- **Artists blockieren / favorisieren**

### SoundCloud
- **Titel-Filter** – Stream-/Listen-Einträge ausblenden, deren Titel den Suchtext nicht enthalten
- **Relatives Tempo** – Speed ±20 % mit Re-Pitch (kein Target-BPM)

## Installation (unpacked)

1. Chrome öffnen → `chrome://extensions`
2. **Entwicklermodus** aktivieren
3. **Entpackte Erweiterung laden**
4. Diesen Ordner auswählen
5. Nach Updates: Extension neu laden

## Nutzung

1. Tab auf `soundeo.com` oder `soundcloud.com` öffnen
2. Extension-Icon klicken → passende View erscheint
3. SoundCloud: Filter/Speed auch als Overlay unten rechts auf der Seite

## Soundeo URL-Logik

```
https://soundeo.com/top100?genreFilter=91&timeFilter=7&...
https://soundeo.com/top100?genreFilter=37&timeFilter=r_2026-07-06_2026-07-13&...
```

- `timeFilter=7` = aktuelle Woche
- `timeFilter=r_YYYY-MM-DD_YYYY-MM-DD` = konkrete Woche (Mo–Mo) oder Kalendermonat (1.–1.)
