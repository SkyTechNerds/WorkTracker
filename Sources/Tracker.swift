//
//  Tracker.swift
//  WorkTracker
//
//  Laufzeit-Kern: beobachtet Lock/Unlock, Sleep/Wake und Idle-Zeit, fuehrt
//  daraus eine aktiv/inaktiv-State-Machine und schreibt Zustandswechsel als
//  Events. Beim Arbeitsbeginn (erster Aktivmoment am Tag bzw. nach laengerer
//  Pause) fragt ein Popup nach, ob die Zeit als Arbeit zaehlen soll. Sampelt
//  periodisch das aktive Repo/Branch/Ticket und meldet neue Tickets.
//

import Foundation
import AppKit
import CoreGraphics
import Combine

enum WorkStatus {
    case active        // arbeitet gerade
    case paused        // Pause (gesperrt/idle/schlaeft/privat)
    case off           // noch nichts heute
    case ended         // Feierabend – fuer heute beendet
}

@MainActor
final class Tracker: ObservableObject {
    let configStore: ConfigStore
    let eventStore: EventStore
    let dayStore: DayStore
    let overtimeStore: OvertimeStore

    @Published var status: WorkStatus = .off
    @Published var stateSince: Date = Date()
    @Published var currentTicket: String?
    @Published var currentRepo: String?
    @Published var todaySummary: DaySummary?
    @Published var dayEnded = false   // Feierabend fuer heute gesetzt
    @Published var inCall = false     // laufender Call erkannt
    @Published var callAppName: String?

    var statusSymbol: String {
        let icon = configStore.config.menuIcon
        return status == .active ? icon.active : icon.idle
    }

    // Zustands-Signale
    private var screenLocked = false
    private var screenAsleep = false   // Display-Sleep = Pause (NICHT System-Sleep)
    private var currentlyActive = false

    // Session-/Tagesentscheidung fuer die Arbeitsbeginn-Nachfrage
    private enum SessionDecision { case undecided, work, notWork }
    private var sessionDecision: SessionDecision = .undecided
    private var inactiveSince: Date?
    private var sawActivationToday = false
    private var currentDayKey = ""
    private var promptShowing = false
    private var lastNotifiedTicket: String?
    private var endedForDay: String?          // Tagesschluessel mit Feierabend
    private var isEnded: Bool { endedForDay == currentDayKey }

    private var evalTimer: Timer?
    private var sampleTimer: Timer?
    private var didStart = false
    private var didStop = false

    init(configStore: ConfigStore) {
        self.configStore = configStore
        self.eventStore = EventStore(eventsDir: configStore.eventsDirURL)
        let grace = TimeInterval(max(180, 2 * configStore.config.sampleIntervalSeconds))
        self.dayStore = DayStore(eventStore: eventStore, dailyDir: configStore.dailyDirURL,
                                 graceSeconds: grace)
        self.overtimeStore = OvertimeStore(dir: configStore.outputURL)
    }

    private var config: AppConfig { configStore.config }

    // MARK: - Lifecycle

    func start() {
        guard !didStart else { return }
        didStart = true
        currentDayKey = EventStore.dayKey(Date())
        registerObservers()
        log(Event(ts: Date(), type: .appStart, reason: "launch"))

        // Nicht sofort als aktiv zaehlen – ueber die State-Machine laufen,
        // damit ggf. die Arbeitsbeginn-Nachfrage erscheint.
        currentlyActive = false
        status = .off

        evalTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.evaluate(reason: "tick")
                self?.refreshSummary()   // Tagessumme live halten
            }
        }
        let interval = TimeInterval(max(15, config.sampleIntervalSeconds))
        sampleTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sample() }
        }

        evaluate(reason: "launch")
        refreshSummary()
    }

    func stop() {
        guard didStart, !didStop else { return }
        didStop = true
        if currentlyActive { log(Event(ts: Date(), type: .inactive, reason: "quit")) }
        log(Event(ts: Date(), type: .appStop, reason: "quit"))
        evalTimer?.invalidate()
        sampleTimer?.invalidate()
    }

    // MARK: - Observers

    private func registerObservers() {
        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.setLocked(true) }
        }
        dnc.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.setLocked(false) }
        }
        let wnc = NSWorkspace.shared.notificationCenter
        // System-Sleep (Zuklappen/Standby) => Feierabend (oder Pause, wenn deaktiviert).
        wnc.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.onSystemSleep() }
        }
        wnc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.onWake() }
        }
        // Display-Sleep (Bildschirm aus) => Pause.
        wnc.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.setScreenAsleep(true) }
        }
        wnc.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.setScreenAsleep(false) }
        }
    }

    private func setLocked(_ v: Bool) {
        guard screenLocked != v else { return }
        screenLocked = v
        log(Event(ts: Date(), type: v ? .lock : .unlock))
        if v { sessionBoundary() }
        evaluate(reason: v ? "lock" : "unlock")
    }

    /// Display-Sleep = Pause.
    private func setScreenAsleep(_ v: Bool) {
        guard screenAsleep != v else { return }
        screenAsleep = v
        log(Event(ts: Date(), type: v ? .sleep : .wake, reason: "display"))
        if v { sessionBoundary() }
        evaluate(reason: v ? "sleep" : "wake")
    }

    /// System-Sleep (Zuklappen/Standby): per Default Feierabend.
    private func onSystemSleep() {
        log(Event(ts: Date(), type: .sleep, reason: "standby"))
        if config.endDayOnSleep {
            manualEndDay()
        } else {
            screenAsleep = true
            sessionBoundary()
            evaluate(reason: "sleep")
        }
    }

    /// Aufwachen aus System-Sleep.
    private func onWake() {
        log(Event(ts: Date(), type: .wake, reason: "standby"))
        screenAsleep = false
        evaluate(reason: "wake")
    }

    /// Sperre/Sleep beendet eine Session: Entscheidung zuruecksetzen, damit beim
    /// naechsten Aktivwerden ggf. erneut nachgefragt wird.
    private func sessionBoundary() {
        sessionDecision = .undecided
        if promptShowing { WorkPrompt.shared.close(); promptShowing = false }
    }

    // MARK: - State machine

    private func idleSeconds() -> TimeInterval {
        let anyType = CGEventType(rawValue: ~UInt32(0)) ?? .null
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyType)
    }

    private func rollDayIfNeeded() {
        let key = EventStore.dayKey(Date())
        if key != currentDayKey {
            currentDayKey = key
            sawActivationToday = false
            sessionDecision = .undecided
            lastNotifiedTicket = nil
            dayEnded = false   // neuer Tag -> Feierabend aufgehoben
        }
    }

    private func evaluate(reason: String) {
        rollDayIfNeeded()

        // Feierabend: fuer heute nichts mehr zaehlen und nicht nachfragen.
        if isEnded {
            currentlyActive = false
            status = .ended
            return
        }
        let threshold = TimeInterval(max(1, config.idleThresholdMinutes) * 60)
        let idle = idleSeconds()
        // Call erkennen: ein laufender Call zählt als aktiv, auch ohne Tastatur-
        // Input (sonst würde ein Meeting fälschlich als Pause erkannt).
        let label = meetingLabel()
        inCall = (label != nil)
        callAppName = label
        let desired = !screenLocked && !screenAsleep && (idle < threshold || inCall)

        // Kein Zustandswechsel noetig.
        if desired == currentlyActive { return }

        if !desired {
            // -> inaktiv (Pause beginnt). Entscheidung zuruecksetzen, damit auch
            // nach langen Idle-Pausen (ohne Sperre) erneut gefragt werden kann.
            currentlyActive = false
            sessionDecision = .undecided
            let ts = (reason == "tick") ? Date().addingTimeInterval(-idle) : Date()
            inactiveSince = ts
            log(Event(ts: ts, type: .inactive, reason: reason))
            status = .paused
            stateSince = ts
            refreshSummary()
            return
        }

        // -> moechte aktiv werden
        if sessionDecision == .notWork {
            // Nutzer hat diese Session als "nicht Arbeit" markiert.
            status = .paused
            return
        }

        let gapMinutes = inactiveSince.map { Date().timeIntervalSince($0) / 60 } ?? .greatestFiniteMagnitude
        let modeWantsPrompt: Bool
        switch config.promptMode {
        case .off:         modeWantsPrompt = false
        case .onceADay:    modeWantsPrompt = !sawActivationToday
        case .afterBreaks: modeWantsPrompt = !sawActivationToday || gapMinutes >= Double(config.promptAfterBreakMinutes)
        case .everyUnlock: modeWantsPrompt = true
        }
        let needConfirm = modeWantsPrompt && sessionDecision == .undecided

        if needConfirm {
            // Ein laufender Call ist eindeutig Arbeit -> ohne Nachfrage starten.
            if inCall {
                if promptShowing { WorkPrompt.shared.close(); promptShowing = false }
                commitActive(reason: "call")
                return
            }
            if !promptShowing { showStartPrompt(gapMinutes: gapMinutes) }
            // Wartet auf Bestätigung – noch keine echte Pause: "Bereit" statt "Pause".
            status = .off
            return
        }

        commitActive(reason: reason)
    }

    /// Beginnt eine Arbeitsphase (zaehlt als Arbeit).
    private func commitActive(reason: String) {
        currentlyActive = true
        sessionDecision = .work
        sawActivationToday = true
        let ts = Date()
        log(Event(ts: ts, type: .active, reason: reason))
        status = .active
        stateSince = ts
        refreshSummary()
        sample()
    }

    private func showStartPrompt(gapMinutes: Double) {
        promptShowing = true
        let message: String
        if !sawActivationToday {
            message = "Soll die Zeit ab jetzt als Arbeit gezählt werden?"
        } else {
            message = "Nach \(Int(gapMinutes)) min Pause – Arbeit fortsetzen oder pausieren?"
        }
        WorkPrompt.shared.show(
            title: "Arbeitszeit erfassen?",
            message: message,
            actions: [
                WorkPromptAction(title: "Pause / privat", prominent: false) { [weak self] in
                    guard let self else { return }
                    self.promptShowing = false
                    self.sessionDecision = .notWork
                    self.status = .paused
                },
                WorkPromptAction(title: "Arbeit starten", prominent: true) { [weak self] in
                    guard let self else { return }
                    self.promptShowing = false
                    self.commitActive(reason: "confirmed")
                }
            ])
    }

    // MARK: - Manuelles Umschalten (Menue-Override)

    func manualStartWork() {
        if promptShowing { WorkPrompt.shared.close(); promptShowing = false }
        guard !currentlyActive else { return }
        commitActive(reason: "manual")
    }

    func manualPause() {
        if promptShowing { WorkPrompt.shared.close(); promptShowing = false }
        sessionDecision = .notWork
        if currentlyActive {
            currentlyActive = false
            let ts = Date()
            inactiveSince = ts
            log(Event(ts: ts, type: .inactive, reason: "manual"))
            stateSince = ts
        }
        status = .paused
        refreshSummary()
    }

    var isWorking: Bool { currentlyActive }

    /// Feierabend: Arbeitszeit fuer heute beenden. Spaetere Nutzung zaehlt nicht
    /// mehr und es wird nicht erneut nachgefragt – bis zum naechsten Tag oder
    /// bis "Arbeit fortsetzen".
    func manualEndDay() {
        if promptShowing { WorkPrompt.shared.close(); promptShowing = false }
        if currentlyActive {
            currentlyActive = false
            let ts = Date()
            inactiveSince = ts
            log(Event(ts: ts, type: .inactive, reason: "feierabend"))
        }
        endedForDay = currentDayKey
        dayEnded = true
        sessionDecision = .notWork
        status = .ended
        stateSince = Date()
        refreshSummary()
        writeReport()
    }

    /// Feierabend aufheben und sofort weiterarbeiten.
    func manualResumeWork() {
        endedForDay = nil
        dayEnded = false
        sessionDecision = .undecided
        manualStartWork()
    }

    // MARK: - Sampling

    private func sample() {
        guard currentlyActive else { return }
        let app = NSWorkspace.shared.frontmostApplication?.localizedName

        var bestRepo: (name: String, branch: String?, ticket: String?, when: Date)?
        for p in config.projects {
            guard let when = GitProbe.lastActivity(p.repoPath) else { continue }
            if bestRepo == nil || when > bestRepo!.when {
                let branch = GitProbe.currentBranch(p.repoPath)
                bestRepo = (p.name, branch, GitProbe.ticket(fromBranch: branch), when)
            }
        }

        currentRepo = bestRepo?.name
        currentTicket = bestRepo?.ticket

        // Mitteilung bei neu erkanntem Ticket.
        if config.notifyTaskStart, let t = bestRepo?.ticket, t != lastNotifiedTicket {
            lastNotifiedTicket = t
            let repoName = bestRepo?.name ?? ""
            Notifier.post(title: "Aufgabe: \(t)", body: repoName)
        }

        let label = meetingLabel()
        inCall = (label != nil)
        callAppName = label

        log(Event(ts: Date(), type: .sample, app: app,
                  repo: bestRepo?.name, branch: bestRepo?.branch,
                  ticket: bestRepo?.ticket, call: label))
    }

    /// Aktueller Meeting-Name oder nil. Primär über den laufenden Kalender-Termin
    /// (zuverlässig); optional zusätzlich per Mikrofon+Call-App (Ad-hoc-Calls),
    /// das aber bei manchen Headsets fehlauslöst -> standardmäßig aus.
    private func meetingLabel() -> String? {
        guard config.detectCalls else { return nil }
        if let title = CalendarLookup.shared.currentEventTitle(), !title.isEmpty { return title }
        if config.detectCallsViaMic, CallDetector.activeCall() != nil { return "Meeting" }
        return nil
    }

    // MARK: - Helpers

    private func log(_ event: Event) {
        eventStore.append(event)
    }

    func refreshSummary() {
        todaySummary = dayStore.summary(date: Date())
    }

    func writeReport(for date: Date = Date()) {
        let summary = dayStore.summary(date: date)
        ReportWriter.write(date: date, summary: summary,
                           config: config, dailyDir: configStore.dailyDirURL)
    }
}
