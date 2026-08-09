# Soundeo Digger

Chrome Extension zum schnelleren Diggen auf [Soundeo](https://soundeo.com).

## Features

- **Genre-Wechsel** – All Genres oder einzelnes Genre → Top 100 Charts
- **Favoriten** – Genres mit ★ merken (sync über Chrome-Profil)
- **Woche navigieren** – Last Week / This Week / Next Week
- **Random Week** – Zufällige Woche aus den letzten X Jahren (konfigurierbar)
- **Downloads ausblenden** – Tracks mit `.download.downloaded` verstecken
- **Gehörte ausblenden** – Extension trackt Plays selbst (`data-track-id`) und speichert sie lokal
  - Play-Button / aktuell spielender Track → automatisch in der Liste
  - Alt+Klick auf einen Track → manuell als gehört toggeln
  - Liste im Popup leeren möglich
- **Preview-BPM** – Ziel-BPM-Slider (Standard 120, 80–160); Track-BPM wird beim Play geladen und per Re-Pitch angeglichen (±20 %)
- **Artists blockieren** – Tracks bestimmter Artists ausblenden (✕ am Track oder Popup)
- **Artists favorisieren** – Tracks grün hervorheben (★ am Track oder Popup)

## Installation (unpacked)

1. Chrome öffnen → `chrome://extensions`
2. **Entwicklermodus** aktivieren (oben rechts)
3. **Entpackte Erweiterung laden**
4. Ordner `Soundeo Links` auswählen
5. Auf soundeo.com die Extension-Icon klicken

## Nutzung

1. Auf einer Soundeo-Seite (am besten `/top100`) die Extension öffnen
2. Genre antippen → lädt Top 100 für dieses Genre (aktueller Wochenfilter bleibt)
3. Sterne für Favoriten setzen
4. Toggle „Bereits heruntergeladene ausblenden“ aktivieren
5. Mit den Wochen-Buttons durch Charts blättern

## URL-Logik

```
https://soundeo.com/top100?genreFilter=91&timeFilter=7&...
https://soundeo.com/top100?genreFilter=37&timeFilter=r_2026-07-06_2026-07-13&...
```

- `timeFilter=7` = aktuelle Woche
- `timeFilter=r_YYYY-MM-DD_YYYY-MM-DD` = konkrete Woche (Mo–Mo)
