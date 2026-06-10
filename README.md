# WorkTracker

Automatischer Arbeitszeit-Tracker für **macOS und Windows** (Electron). Läuft in der
Menüleiste/Tray, erfasst Arbeitszeit und Pausen automatisch, ordnet Tickets zu und lässt
sich manuell wie per API/KI nachpflegen.

> Cross-Platform-Nachfolger der ursprünglichen macOS-Swift-App. Der Swift-Stand bleibt in
> der Git-Historie erhalten (Release `v0.1.14`).

---

## Features

### Automatische Erfassung
- **Aktiv/Pause** aus Idle-Zeit, Bildschirmsperre und Standby (`powerMonitor`,
  plattformunabhängig).
- **Konfigurierbare Schwellen:** Inaktiv-ab (Minuten), Pausen-Limit/Tag, Buchungsrundung
  (Standard 15 min).
- App-Neustart-Lücken (< 30 min) werden als durchgehende Arbeit gewertet, nicht als Pause.

### Frage-Popup beim Wiederaufnehmen
- Beim Entsperren nach einer Pause: **„Arbeit / Pause / Privat"** — das Popup entscheidet.
  „Pause/Privat" zählt **nicht** als Arbeitszeit und hält die Pause, bis „Arbeiten" geklickt
  wird.
- Frage-Modus wählbar: aus · einmal täglich · nach Pausen (mit Schwelle) · bei jedem
  Entsperren.

### Pausen & Feierabend
- **Manuelle Pause** hält an (springt nicht durch Idle zurück auf Arbeit).
- **Feierabend ist persistent** – überlebt App-Neustarts und endet automatisch beim
  Tageswechsel. Optional Feierabend bei Zuklappen/Standby.
- **Zustandsabhängiges Menüleisten-Icon:** Aktentasche (Arbeit) · Kaffeetasse (Pause) ·
  Mond (Feierabend). Aktive Aktion im Menü/Toolbar ist deaktiviert.

### Kalender
- Tages-Timeline mit **Drag-Resize/Move** (Snap auf Buchungsrundung), Blöcke überlagern
  sich nie.
- **Ticket auf Zeitraum buchen** (Von–Bis) – Pausen im Zeitraum werden automatisch
  abgezogen; mehrfach pro Tag buchbar.
- **Einzel-Eintrag** und Block-Editor (Art Arbeit/Pause/Meeting, Zeiten, Ticket, Projekt,
  Beschreibung).
- **Sidebar „Zeit je Ticket"** nach Projekt/Kunde gruppiert; Klick öffnet die Detailansicht
  mit allen Zeitspannen, Gesamtzeit und „+ Zeit hinzufügen".
- **Beschreibungsfeld** in jedem Eingabeweg (was wurde gemacht).
- Bearbeitete Tage sind statisch; nur „heute" wächst der laufende Eintrag weiter.

### Projekte mit Farben
- Projekte (Repo-Pfad + Git-User-Email) mit **eigener Farbe** (zufällig, unterscheidbar).
- Tickets erscheinen im Kalender in **Projektfarbe**: Arbeit blau, Pause grau, Meeting lila,
  Ticket = Projektfarbe.

### KI-Ticket-Zuordnung
- Ordnet Arbeitsblöcken anhand der **Git-Commits des Tages** automatisch Ticket, Projekt und
  eine Kurzbeschreibung zu (zeitliche Nähe).
- Anbieter **Gemini / OpenAI / MiniMax**, Modell-Auswahl (lädt verfügbare Modelle), API-Key,
  Verbindungstest. ✨-Button erscheint nur bei aktivierter KI.

### Teams-Meeting-Erkennung
- Erkennt laufende Teams-Calls über die **lokale Drittanbieter-API** (WebSocket
  `127.0.0.1:8124`). Nach spontanem Call optional Abfrage von **Titel + Kunde/Projekt**
  (manuell, für die Abrechnung); „war kein Meeting" zählt als normale Arbeit. Hinweis,
  falls die Teams-API nicht erreichbar ist.

### MQTT / Home Assistant
- Sendet **Status, Im-Call, Gearbeitet heute/Woche, Pause, Überstunden,
  aktuelles Ticket** an einen beliebigen MQTT-Broker.
- Optionale **Home-Assistant-Discovery** (legt Entities automatisch an), Availability/LWT,
  pro Wert einzeln aktivierbar, Verbindungstest.

### HTTP-API (Steuerung von außen)
- Lokaler Endpunkt (`127.0.0.1`, Token-geschützt) zum Lesen/Setzen von Einträgen – z. B. bei
  Figma-/Design-Arbeit ohne Git-Commits.
- Routen: `GET /api/health` · `GET /api/projects` · `GET /api/day` · `POST /api/assign` ·
  `POST /api/day` · `POST /api/reset`.
- **MCP-Server** dazu: [**SkyTechNerds/worktracker-mcp**](https://github.com/SkyTechNerds/worktracker-mcp)
  – stellt diese API als [MCP](https://modelcontextprotocol.io)-Tools bereit, sodass jeder
  MCP-fähige Agent (Claude Code, ChatGPT Desktop, Cursor, Codex …) Zeiten per Sprache erfassen
  kann („trag 14–15:30 Figma für JUMO ein").

### Überstunden, Reports, Updates
- **Überstunden-Konto** (Soll-Stunden/Tag, Arbeitstage, Startsaldo) mit Tagestabelle.
- **Reports** als Markdown oder CSV pro Tag.
- **Auto-Update** über GitHub Releases (Hinweis + Link), **Autostart** beim Anmelden.

---

## Entwicklung

```bash
npm install
npm run dev          # electron-vite Dev-Modus
npm run build        # Production-Build nach out/
npm run typecheck    # tsc --noEmit
npm run package:mac  # unsignierte .app nach dist/mac-arm64/
```

## Architektur

```
src/main/            Electron-Hauptprozess
  index.ts           Tray, Fenster, IPC, Wiring
  lib/tracker.ts     Aktiv/Pause/Feierabend-Logik (powerMonitor)
  lib/day.ts         Ableitung der Tages-Segmente aus Roh-Events
  lib/store.ts       Persistenz (Config, Events JSONL, Overrides, Feierabend-Marker)
  lib/teams.ts       Teams-WebSocket   lib/mqtt.ts  MQTT/HA   lib/ai.ts  KI
  lib/apiServer.ts   lokale HTTP-API   lib/git.ts   Git-Probe   lib/updater.ts
src/preload/         contextBridge-API (window.wt)
src/renderer/        React-UI (Kalender, Überstunden, Einstellungen, Popup)
```

Daten liegen unter dem Electron-`userData`-Pfad
(`~/Library/Application Support/worktracker` bzw. `%APPDATA%\worktracker`).

## Konfiguration

Alle Einstellungen über das UI (Tray → „Einstellungen…"): **Projekte, Erfassung, Meetings,
KI, Überstunden, Anzeige, MQTT, API**. Gespeichert in `config.json` im userData-Pfad.
