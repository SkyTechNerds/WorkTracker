# WorkTracker

Native macOS-Menüleisten-App, die **automatisch** Arbeitszeit, Pausen und
bearbeitete Tickets erfasst — passiv im Hintergrund, ohne Start/Stopp-Klicken.
Gebaut mit SwiftUI/AppKit, ohne Xcode-Projekt (ein `swiftc`-Build-Script).

![Icon](AppIcon.png)

## Funktionen

### Arbeitszeit & Pausen (automatisch)
Erkennt aktiv/inaktiv aus drei Signalen, ohne manuelle Eingabe:
- **Lock/Unlock** des Bildschirms (`com.apple.screenIsLocked` / `…Unlocked`)
- **Sleep/Wake** des Systems (`NSWorkspace`)
- **Inaktivität** ohne Sperren (`CGEventSource`-Idle-Zeit, Schwelle einstellbar)

Erster Aktivmoment = Arbeitsbeginn, letzter = Ende, Lücken = Pausen. Eine
laufende Pause wird live mitgezählt.

### Nachfrage beim Arbeitsbeginn
Damit privates Aufklappen abends nicht als Arbeit zählt, fragt ein zentriertes
Popup „Arbeit starten / Pause". Modus wählbar:
- **Nie fragen** – alles zählt automatisch
- **Einmal am Tag** – nur beim ersten Aktivwerden
- **Erststart + nach langen Pausen** (Standard, Schwelle einstellbar)
- **Bei jeder Rückkehr**

### Feierabend
Beendet die Arbeitszeit für den ganzen Tag (Menü **und** Kalender-Toolbar).
Danach zählt Abend-Nutzung nicht mehr und es kommt kein Popup — bis zum nächsten
Tag oder „Arbeit fortsetzen".

### Tickets & Tätigkeit (aus Git)
Sampelt periodisch das aktive Repo → Branch → **Ticket** (`wcms-2155-…` →
`WCMS-2155`). Beim Wechsel optional eine Mitteilung. Der Bericht listet die
Commits des Tages je Ticket.

### Kalender + manuelles Editieren
- **Tagesansicht:** Zeitachse mit farbigen Arbeits-/Pausenblöcken; Block
  anklicken zum Bearbeiten (Zeit/Ticket/Notiz), „+ Eintrag" für nachgetragene
  Zeiten, „Auf Auto" verwirft manuelle Korrekturen.
- **Wochenübersicht:** Tagessummen, Klick öffnet den Tag.
- **Zeit je Ticket:** Panel in Tages- und Wochenansicht (Summe + Beschreibung).

### KI-Tätigkeitsbeschreibung
Optional: Aus den Git-Commits eines Tages erzeugt ein LLM je Ticket einen kurzen
deutschen Satz „was wurde gemacht" und füllt die leeren Zeitblöcke (✨-Button im
Ticket-Panel). OpenAI-kompatibel → funktioniert mit **MiniMax**, **OpenAI** und
**Google Gemini** (Basis-URL + Key + Modell in den Einstellungen).

### Buchung & Export
- Zeit-**Rundung** auf 5/15/30 min (oder exakt) für die ausgewiesenen Summen.
- Pro Tag **Markdown** (lesbar) + **CSV** (maschinenlesbar).

## Build

```bash
./build.sh                 # erzeugt WorkTracker.app (arm64, ad-hoc signiert)
cp -R WorkTracker.app /Applications/
open /Applications/WorkTracker.app
```

Voraussetzung: macOS 14+, Xcode Command Line Tools (Swift 5.9+). Reine
Apple-Silicon-Builds; für Intel `build.sh` auf ein Universal Binary erweitern.

### App-Icon
`AppIcon.png` (1024²) im Projektroot wird von `build.sh` automatisch zu
`AppIcon.icns` konvertiert. Das mitgelieferte Icon lässt sich mit
`swift generate_icon.swift` neu erzeugen (Farben/Symbol dort anpassbar).

### Paket zum Verteilen
```bash
./package.sh               # baut ~/Downloads/WorkTracker.zip
```
Empfänger: entpacken → nach /Programme → **Rechtsklick → „Öffnen"** (ad-hoc
signiert, nicht notarisiert). Reibungslose Verteilung bräuchte Developer-ID +
Notarisierung.

## Daten & Ablage

| Was | Ort |
|---|---|
| Konfiguration (inkl. API-Key) | `~/Library/Application Support/WorkTracker/config.json` |
| Roh-Events (append-only) | `~/WorkLog/events/YYYY-MM-DD.jsonl` |
| Manuelle Korrekturen | `~/WorkLog/daily/YYYY-MM-DD.edits.json` |
| Tagesbericht | `~/WorkLog/daily/YYYY-MM-DD.md` + `.csv` |

Output-Ordner und alle Parameter sind in den Einstellungen änderbar. Beim
ersten Start ist die Projektliste leer — eigene Repos unter
**Einstellungen → Projekte** anlegen (Repo-Pfad + zugeordnete Git-Identität).

## Architektur (`Sources/`)

| Datei | Rolle |
|---|---|
| `WorkTrackerApp.swift` | App-Entry: MenuBarExtra + Kalender-/Settings-Fenster, Aktivierungs-Policy |
| `Tracker.swift` | State-Machine aktiv/inaktiv, Prompt-/Feierabend-Logik, Sampling |
| `ActivityMonitor`/Observer | Lock/Unlock/Sleep/Wake + Idle (in `Tracker`) |
| `EventStore.swift` | Append-only JSONL-Events (Quelle der Wahrheit) |
| `DayModel.swift` | Events → Segmente, Overrides, Crash-Cap, Zeit je Ticket |
| `GitProbe.swift` | Branch/Ticket/Commits + User-Discovery |
| `ReportWriter.swift` | Markdown- + CSV-Bericht |
| `LLMClient.swift` | OpenAI-kompatibler Chat-Client (KI) |
| `Notifier.swift` | Lokale Mitteilungen |
| `Config.swift` | config.json (Modell, tolerante Migration) |
| `CalendarView.swift` | Tages-/Wochen-Timeline, Editing, Ticket-Panel, KI |
| `SegmentEditorView.swift` | Block bearbeiten/hinzufügen |
| `SettingsView.swift` | Allgemein / Projekte / KI |
| `PromptWindow.swift` | Zentriertes „Arbeit/Pause"-Popup |
| `Formatting.swift` | Format-/Rundungs-Helfer |

### Datenmodell
Roh-Events sind unveränderlich. Manuelle Korrekturen materialisieren den Tag in
`*.edits.json`; „Auf Auto" stellt die Ableitung wieder her. Offene (nicht sauber
beendete) Tage werden gegen Hochzählen bis Mitternacht abgesichert.

## Tests
`verify_main.swift` ist ein eigenständiges Harness für die Nicht-GUI-Logik
(Segmente, Pausen, Crash-Cap, Zeit je Ticket, Rundung, Bericht). Kompilieren:

```bash
SDK="$(xcrun --show-sdk-path --sdk macosx)"
cp verify_main.swift /tmp/main.swift
swiftc -swift-version 5 -sdk "$SDK" -target "$(uname -m)-apple-macosx14.0" \
  Sources/{Config,EventStore,DayModel,GitProbe,Formatting,ReportWriter}.swift \
  /tmp/main.swift -o /tmp/wt-verify && /tmp/wt-verify
```

## Hinweise
- Keine Sonderrechte: Idle-Erkennung braucht **keine** Bedienungshilfen-Freigabe.
- Mitteilungen erfordern eine einmalige Berechtigung beim ersten Start.
- Der API-Key liegt im Klartext in der lokalen `config.json`.
