//
//  WorkTrackerApp.swift
//  WorkTracker
//
//  App-Einstieg: Menueleisten-Extra (kein Dock-Icon), Kalenderfenster und
//  Einstellungen. Folgt den macOS Human Interface Guidelines (Template-Icon,
//  Standard-Controls, Settings-Scene via ⌘,).
//
//  Wichtig: Der Tracker wird im AppDelegate (applicationDidFinishLaunching)
//  gestartet – NICHT im onAppear des Menue-Inhalts, denn dessen Inhalt wird
//  erst beim Oeffnen des Menues erzeugt.
//

import SwiftUI
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let configStore: ConfigStore
    let tracker: Tracker

    override init() {
        let cs = ConfigStore()
        configStore = cs
        tracker = Tracker(configStore: cs)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Notifier.requestAuthorization()
        // Kalender-Zugriff NICHT beim Start anfragen – erst lazy, wenn wirklich
        // ein Call läuft (siehe CalendarLookup.currentEventTitle).
        tracker.start()

        if configStore.config.autoCheckUpdates {
            let autoInstall = configStore.config.autoInstallUpdates
            let beta = configStore.config.betaUpdates
            Task {
                await Updater.shared.check(silent: true, beta: beta)
                if Updater.shared.available != nil, autoInstall {
                    await Updater.shared.installUpdate()
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        tracker.stop()
    }
}

/// Verwaltet die Aktivierungs-Policy: Als Menueleisten-App laeuft WorkTracker
/// als `.accessory` (kein Dock-Icon). Beim Oeffnen eines echten Fensters wird
/// kurz auf `.regular` gewechselt, damit das Fenster den Fokus bekommt (sonst
/// oeffnen Settings/Sheets nicht zuverlaessig). Nach dem Schliessen zurueck.
@MainActor
enum AppActivation {
    static func showWindow(_ open: () -> Void) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        open()
    }

    /// Nach Fenster-Schliessen: wenn kein sichtbares Fenster mehr offen ist,
    /// zurueck in den Hintergrund (kein Dock-Icon).
    static func updatePolicyAfterClose() {
        let stillOpen = NSApp.windows.contains { win in
            win.isVisible && win.canBecomeMain && !(win is NSPanel)
        }
        if !stillOpen {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

@main
struct WorkTrackerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(tracker: appDelegate.tracker)
                .environmentObject(appDelegate.configStore)
        } label: {
            MenuBarLabel(tracker: appDelegate.tracker, configStore: appDelegate.configStore)
        }

        Window("WorkTracker", id: "calendar") {
            CalendarView(tracker: appDelegate.tracker)
                .environmentObject(appDelegate.configStore)
                .onDisappear { AppActivation.updatePolicyAfterClose() }
        }
        .defaultSize(width: 880, height: 620)

        Window("Überstunden", id: "overtime") {
            OvertimeView(tracker: appDelegate.tracker, store: appDelegate.tracker.overtimeStore)
                .environmentObject(appDelegate.configStore)
                .onDisappear { AppActivation.updatePolicyAfterClose() }
        }
        .defaultSize(width: 640, height: 560)

        Window("Einstellungen", id: "settings") {
            SettingsView()
                .environmentObject(appDelegate.configStore)
                .onDisappear { AppActivation.updatePolicyAfterClose() }
        }
        .defaultSize(width: 580, height: 480)
        .windowResizability(.contentSize)
    }
}

/// Menueleisten-Icon, das Live-Status und Icon-Einstellung beobachtet.
struct MenuBarLabel: View {
    @ObservedObject var tracker: Tracker
    @ObservedObject var configStore: ConfigStore
    var body: some View {
        Image(systemName: tracker.statusSymbol)
    }
}

/// Inhalt des Menueleisten-Menues.
struct MenuContentView: View {
    @ObservedObject var tracker: Tracker
    @ObservedObject private var updater = Updater.shared
    @EnvironmentObject var configStore: ConfigStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        statusHeader

        if let info = updater.available {
            Divider()
            Button(updater.installing ? "Installiere v\(info.version)…" : "⬆︎ Update auf v\(info.version) installieren") {
                Task { await updater.installUpdate() }
            }
            .disabled(updater.installing)
        }

        Divider()

        if tracker.dayEnded {
            Button("Arbeit fortsetzen") { tracker.manualResumeWork() }
        } else {
            if tracker.status == .active {
                Button("Pause / privat") { tracker.manualPause() }
            } else {
                let startedToday = (tracker.todaySummary?.start != nil)
                Button(startedToday ? "Arbeit fortsetzen" : "Arbeit starten") {
                    tracker.manualStartWork()
                }
            }
            Button("Feierabend") { tracker.manualEndDay() }
        }

        Divider()

        Button("Kalender & Bericht öffnen") {
            AppActivation.showWindow { openWindow(id: "calendar") }
        }
        Button("Überstunden öffnen") {
            AppActivation.showWindow { openWindow(id: "overtime") }
        }
        Button("Bericht jetzt aktualisieren") {
            tracker.writeReport()
            tracker.refreshSummary()
        }
        Button("Ordner im Finder zeigen") {
            NSWorkspace.shared.open(configStore.outputURL)
        }

        Divider()

        if updater.available == nil {
            Button(updater.checking ? "Suche Updates…" : "Nach Updates suchen") {
                Task { await updater.check(silent: false, beta: configStore.config.betaUpdates) }
            }
            .disabled(updater.checking)
        }

        Button("Einstellungen…") {
            AppActivation.showWindow { openWindow(id: "settings") }
        }
        .keyboardShortcut(",")
        Button("WorkTracker beenden") {
            NSApp.terminate(nil)
        }
        .keyboardShortcut("q")
    }

    @ViewBuilder
    private var statusHeader: some View {
        let dayStart = tracker.todaySummary?.start
        switch tracker.status {
        case .active:
            Text("● Arbeit läuft")
            if let t = tracker.currentTicket {
                Text("Ticket: \(t)").foregroundStyle(.secondary)
            } else if let r = tracker.currentRepo {
                Text(r).foregroundStyle(.secondary)
            }
        case .paused:
            Text("◐ Pause seit \(Fmt.clock(tracker.stateSince))")
        case .off:
            Text("○ Bereit")
        case .ended:
            Text("✓ Feierabend")
        }
        if tracker.inCall {
            Text("📞 Call läuft\(tracker.callAppName.map { " (\($0))" } ?? "")")
                .foregroundStyle(.secondary)
        }
        if let start = dayStart {
            Text("Arbeitsbeginn: \(Fmt.clock(start))")
                .foregroundStyle(.secondary)
        }
        if let s = tracker.todaySummary {
            Text("Heute: \(Fmt.hm(s.workedSeconds)) · Pause \(Fmt.hm(s.breakSeconds))")
                .foregroundStyle(.secondary)
        }
    }
}
