//
//  Config.swift
//  WorkTracker
//
//  App-Konfiguration: Projekte (Repo + zugeordneter Git-User), Output-Ordner
//  und Tracking-Parameter. Persistiert als JSON in Application Support.
//

import Foundation
import Combine

/// Ein gepflegtes Projekt: ein Git-Repo plus die Git-Identität, die als "ich"
/// für den Commit-Filter zählt.
struct Project: Codable, Identifiable, Hashable {
    var id: UUID = UUID()
    var name: String
    var repoPath: String
    /// E-Mail der Git-Identität, deren Commits als "meine" Tätigkeit zählen.
    var gitUserEmail: String

    init(id: UUID = UUID(), name: String, repoPath: String, gitUserEmail: String) {
        self.id = id
        self.name = name
        self.repoPath = repoPath
        self.gitUserEmail = gitUserEmail
    }
}

/// Wann beim Aktivwerden nach "Arbeit/Pause" gefragt wird.
enum PromptMode: String, Codable, CaseIterable, Identifiable {
    case off          // nie fragen – alles zählt automatisch als Arbeit
    case onceADay     // nur beim ersten Aktivwerden am Tag
    case afterBreaks  // erster Aktivmoment + nach längeren Pausen
    case everyUnlock  // bei jeder Rückkehr (Entsperren/Aufwachen)

    var id: String { rawValue }

    var label: String {
        switch self {
        case .off:         return "Nie fragen (alles automatisch)"
        case .onceADay:    return "Einmal am Tag"
        case .afterBreaks: return "Erststart + nach langen Pausen"
        case .everyUnlock: return "Bei jeder Rückkehr"
        }
    }
}

/// Auswahl des Menueleisten-Icons (SF Symbols, Template-faehig).
enum MenuIconStyle: String, Codable, CaseIterable, Identifiable {
    case briefcase
    case building
    case institution
    case hammer
    case clock

    var id: String { rawValue }

    var label: String {
        switch self {
        case .briefcase:   return "Aktentasche"
        case .building:    return "Bürogebäude"
        case .institution: return "Behörde"
        case .hammer:      return "Hammer"
        case .clock:       return "Uhr"
        }
    }

    /// Symbol im Arbeitszustand (gefuellt).
    var active: String {
        switch self {
        case .briefcase:   return "briefcase.fill"
        case .building:    return "building.2.fill"
        case .institution: return "building.columns.fill"
        case .hammer:      return "hammer.fill"
        case .clock:       return "clock.fill"
        }
    }

    /// Symbol im Pause-/Bereit-Zustand (Umriss).
    var idle: String {
        switch self {
        case .briefcase:   return "briefcase"
        case .building:    return "building.2"
        case .institution: return "building.columns"
        case .hammer:      return "hammer"
        case .clock:       return "clock"
        }
    }
}

/// CodingKey fuer beliebige Namen (Legacy-Migration).
struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// KI-Anbieter (OpenAI-kompatibel) mit Endpoint, Modell-Vorschlägen und der
/// Seite, auf der man einen API-Key bekommt.
enum AIProvider: String, Codable, CaseIterable, Identifiable {
    case gemini
    case minimax
    case openai
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .gemini:  return "Google Gemini"
        case .minimax: return "MiniMax"
        case .openai:  return "OpenAI"
        case .custom:  return "Eigener (OpenAI-kompatibel)"
        }
    }

    var baseURL: String {
        switch self {
        case .gemini:  return "https://generativelanguage.googleapis.com/v1beta/openai"
        case .minimax: return "https://api.minimax.io/v1"
        case .openai:  return "https://api.openai.com/v1"
        case .custom:  return ""
        }
    }

    var models: [String] {
        switch self {
        case .gemini:  return ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"]
        case .minimax: return ["MiniMax-Text-01"]
        case .openai:  return ["gpt-4o-mini", "gpt-4o", "o4-mini"]
        case .custom:  return []
        }
    }

    /// Seite, auf der man den API-Key erhält.
    var keyURL: String? {
        switch self {
        case .gemini:  return "https://aistudio.google.com/apikey"
        case .minimax: return "https://www.minimax.io/platform"
        case .openai:  return "https://platform.openai.com/api-keys"
        case .custom:  return nil
        }
    }

    static func infer(fromBaseURL url: String) -> AIProvider {
        let u = url.lowercased()
        if u.contains("googleapis") { return .gemini }
        if u.contains("minimax")    { return .minimax }
        if u.contains("openai.com") { return .openai }
        return .custom
    }
}

/// Gesamte App-Konfiguration.
struct AppConfig: Codable, Equatable {
    var outputDir: String
    var projects: [Project]
    var idleThresholdMinutes: Int
    var sampleIntervalSeconds: Int
    var breakCapMinutes: Int
    var startAtLogin: Bool
    var workdayStartHour: Int
    var workdayEndHour: Int
    // Nachfrage beim Arbeitsbeginn (Popup "Arbeit/Pause").
    var promptMode: PromptMode
    var promptAfterBreakMinutes: Int
    // Zuklappen/Standby (System-Sleep) zählt als Feierabend (statt nur Pause).
    var endDayOnSleep: Bool
    // Calls (Teams/Zoom/…) erkennen und als "Meeting" labeln.
    var detectCalls: Bool
    // Mitteilung bei neu erkanntem Ticket.
    var notifyTaskStart: Bool
    // Menueleisten-Icon.
    var menuIcon: MenuIconStyle
    // Rundung der ausgewiesenen Zeiten in Minuten (0 = exakt, z. B. 15).
    var roundingMinutes: Int
    // Überstunden-Konto: Soll-Stunden pro Arbeitstag, Arbeitstage (Wochentage,
    // gregorianisch: 1=So…7=Sa), Startsaldo (Übertrag in Stunden).
    var targetHoursPerDay: Double
    var workdayWeekdays: [Int]
    var overtimeStartBalanceHours: Double
    // KI-Taetigkeitsbeschreibung (OpenAI-kompatibel: Gemini/MiniMax/OpenAI).
    var aiEnabled: Bool
    var aiProvider: AIProvider
    var aiBaseURL: String
    var aiModel: String
    var aiApiKey: String

    static var defaultOutputDir: String {
        (NSHomeDirectory() as NSString).appendingPathComponent("WorkLog")
    }

    static func makeDefault() -> AppConfig {
        AppConfig(
            outputDir: defaultOutputDir,
            projects: [],
            idleThresholdMinutes: 6,
            sampleIntervalSeconds: 60,
            breakCapMinutes: 30,
            startAtLogin: false,
            workdayStartHour: 6,
            workdayEndHour: 20,
            promptMode: .afterBreaks,
            promptAfterBreakMinutes: 20,
            endDayOnSleep: true,
            detectCalls: true,
            notifyTaskStart: true,
            menuIcon: .briefcase,
            roundingMinutes: 0,
            targetHoursPerDay: 8.0,
            workdayWeekdays: [2, 3, 4, 5, 6],
            overtimeStartBalanceHours: 0,
            aiEnabled: false,
            aiProvider: .gemini,
            aiBaseURL: AIProvider.gemini.baseURL,
            aiModel: "gemini-2.5-flash",
            aiApiKey: ""
        )
    }
}

extension AppConfig {
    /// Toleranter Decoder: fehlende (neue) Felder fallen auf Defaults zurueck,
    /// damit aeltere config.json-Dateien nicht ungueltig werden.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppConfig.makeDefault()
        outputDir = try c.decodeIfPresent(String.self, forKey: .outputDir) ?? d.outputDir
        projects = try c.decodeIfPresent([Project].self, forKey: .projects) ?? d.projects
        idleThresholdMinutes = try c.decodeIfPresent(Int.self, forKey: .idleThresholdMinutes) ?? d.idleThresholdMinutes
        sampleIntervalSeconds = try c.decodeIfPresent(Int.self, forKey: .sampleIntervalSeconds) ?? d.sampleIntervalSeconds
        breakCapMinutes = try c.decodeIfPresent(Int.self, forKey: .breakCapMinutes) ?? d.breakCapMinutes
        startAtLogin = try c.decodeIfPresent(Bool.self, forKey: .startAtLogin) ?? d.startAtLogin
        workdayStartHour = try c.decodeIfPresent(Int.self, forKey: .workdayStartHour) ?? d.workdayStartHour
        workdayEndHour = try c.decodeIfPresent(Int.self, forKey: .workdayEndHour) ?? d.workdayEndHour
        promptAfterBreakMinutes = try c.decodeIfPresent(Int.self, forKey: .promptAfterBreakMinutes) ?? d.promptAfterBreakMinutes
        endDayOnSleep = try c.decodeIfPresent(Bool.self, forKey: .endDayOnSleep) ?? d.endDayOnSleep
        detectCalls = try c.decodeIfPresent(Bool.self, forKey: .detectCalls) ?? d.detectCalls
        notifyTaskStart = try c.decodeIfPresent(Bool.self, forKey: .notifyTaskStart) ?? d.notifyTaskStart
        menuIcon = try c.decodeIfPresent(MenuIconStyle.self, forKey: .menuIcon) ?? d.menuIcon
        roundingMinutes = try c.decodeIfPresent(Int.self, forKey: .roundingMinutes) ?? d.roundingMinutes
        targetHoursPerDay = try c.decodeIfPresent(Double.self, forKey: .targetHoursPerDay) ?? d.targetHoursPerDay
        workdayWeekdays = try c.decodeIfPresent([Int].self, forKey: .workdayWeekdays) ?? d.workdayWeekdays
        overtimeStartBalanceHours = try c.decodeIfPresent(Double.self, forKey: .overtimeStartBalanceHours) ?? d.overtimeStartBalanceHours
        aiEnabled = try c.decodeIfPresent(Bool.self, forKey: .aiEnabled) ?? d.aiEnabled
        aiBaseURL = try c.decodeIfPresent(String.self, forKey: .aiBaseURL) ?? d.aiBaseURL
        aiModel = try c.decodeIfPresent(String.self, forKey: .aiModel) ?? d.aiModel
        aiApiKey = try c.decodeIfPresent(String.self, forKey: .aiApiKey) ?? d.aiApiKey
        // Provider neu – sonst aus der Basis-URL ableiten (Bestandskonfig).
        aiProvider = try c.decodeIfPresent(AIProvider.self, forKey: .aiProvider)
            ?? AIProvider.infer(fromBaseURL: aiBaseURL)

        // promptMode (neu) – sonst Legacy-Bool "confirmStart" uebernehmen.
        if let m = try c.decodeIfPresent(PromptMode.self, forKey: .promptMode) {
            promptMode = m
        } else {
            let any = try decoder.container(keyedBy: AnyCodingKey.self)
            let legacy = try any.decodeIfPresent(Bool.self, forKey: AnyCodingKey("confirmStart"))
            promptMode = (legacy ?? true) ? .afterBreaks : .off
        }
    }
}

/// Lädt/speichert die Konfiguration und stellt sie als beobachtbares Objekt bereit.
final class ConfigStore: ObservableObject {
    @Published var config: AppConfig

    /// Feste Position der Config-Datei (vermeidet Henne-Ei mit outputDir).
    static var configURL: URL {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("WorkTracker", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("config.json")
    }

    init() {
        if let loaded = ConfigStore.loadFromDisk() {
            self.config = loaded
            ensureOutputDir()
        } else {
            self.config = AppConfig.makeDefault()
            ensureOutputDir()
            save() // Default-Config beim ersten Start sichtbar ablegen.
        }
    }

    private static func loadFromDisk() -> AppConfig? {
        guard let data = try? Data(contentsOf: configURL) else { return nil }
        return try? JSONDecoder().decode(AppConfig.self, from: data)
    }

    func save() {
        ensureOutputDir()
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(config) {
            try? data.write(to: ConfigStore.configURL, options: .atomic)
        }
    }

    func ensureOutputDir() {
        try? FileManager.default.createDirectory(
            atPath: config.outputDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(
            atPath: (config.outputDir as NSString).appendingPathComponent("events"),
            withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(
            atPath: (config.outputDir as NSString).appendingPathComponent("daily"),
            withIntermediateDirectories: true)
    }

    var outputURL: URL { URL(fileURLWithPath: config.outputDir, isDirectory: true) }
    var eventsDirURL: URL { outputURL.appendingPathComponent("events", isDirectory: true) }
    var dailyDirURL: URL { outputURL.appendingPathComponent("daily", isDirectory: true) }
}
