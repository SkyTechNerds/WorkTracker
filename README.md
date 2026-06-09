# WorkTracker

Automatischer Arbeitszeit-Tracker für **macOS und Windows** (Electron). Läuft in der
Menüleiste/Tray, erfasst Arbeitszeit und Pausen automatisch und ordnet Tickets zu.

> Cross-Platform-Nachfolger der ursprünglichen macOS-Swift-App (deren Stand bleibt in der
> Git-Historie erhalten).

## Features

- **Automatische Erfassung** – aktiv/Pause aus Idle, Bildschirmsperre und Standby
  (`powerMonitor`, plattformunabhängig).
- **Kalender** mit Drag-Resize/Move, Zeitraum-Buchung (Von–Bis, Pausen werden abgezogen),
  Einzel-Einträgen und Beschreibungsfeldern.
- **Projekte mit Farben** – Tickets erscheinen im Kalender in Projektfarbe.
- **Pausen & Feierabend** – manuelle Pause hält an; Feierabend ist persistent und endet
  automatisch beim Tageswechsel. Zustandsabhängiges Menüleisten-Icon
  (Aktentasche / Kaffeetasse / Mond).
- **Frage-Popup** beim Wiederaufnehmen (Arbeit / Pause / Privat) – Popup entscheidet.
- **Teams-Meeting-Erkennung** über die lokale Teams-Drittanbieter-API (WebSocket).
- **KI-Ticket-Zuordnung** aus Git-Commits (Gemini / OpenAI / MiniMax).
- **MQTT / Home Assistant** – sendet Status, Zeiten, Überstunden; optional HA-Discovery.
- **HTTP-API** (`127.0.0.1`, Token) zum Setzen von Einträgen von außen.
- **Überstunden-Konto**, Reports (Markdown/CSV), Auto-Update über GitHub Releases,
  Autostart.

## Entwicklung

```bash
npm install
npm run dev        # electron-vite Dev-Modus
npm run build      # Production-Build (out/)
npm run typecheck  # tsc --noEmit
npm run package:mac # unsignierte .app nach dist/mac-arm64/
```

## Architektur

- `src/main/` – Electron-Hauptprozess (Tracker, Tray, IPC, Teams, MQTT, KI, API-Server).
- `src/main/lib/day.ts` – Ableitung der Tages-Segmente aus den Roh-Events.
- `src/preload/` – contextBridge-API (`window.wt`).
- `src/renderer/` – React-UI (Kalender, Überstunden, Einstellungen).

Daten liegen unter dem Electron-`userData`-Pfad
(`~/Library/Application Support/worktracker` bzw. `%APPDATA%\worktracker`).
