//
//  EventStore.swift
//  WorkTracker
//
//  Append-only Roh-Event-Log (eine JSONL-Datei pro Tag). Dies ist die
//  unveraenderliche Quelle der Wahrheit; manuelle Korrekturen leben getrennt
//  in den Overrides (siehe DayStore).
//

import Foundation

enum EventType: String, Codable {
    case appStart      // App gestartet (Login/Autostart)
    case appStop       // App beendet
    case active        // wurde aktiv (Arbeit beginnt/wird fortgesetzt)
    case inactive      // wurde inaktiv (Pause beginnt)
    case lock          // Bildschirm gesperrt
    case unlock        // Bildschirm entsperrt
    case sleep         // System schlaeft ein
    case wake          // System wacht auf
    case sample        // periodischer Schnappschuss (App + Branch + Ticket)
}

struct Event: Codable, Identifiable {
    var id: UUID = UUID()
    var ts: Date
    var type: EventType
    /// Grund fuer einen Zustandswechsel: "idle" | "lock" | "sleep" | "input" | ...
    var reason: String?
    /// Name der Vordergrund-App zum Sample-Zeitpunkt.
    var app: String?
    /// Name des aktiven Repos (best guess).
    var repo: String?
    /// Aktueller Branch des aktiven Repos.
    var branch: String?
    /// Aus dem Branch geparstes Ticket (z. B. WCMS-2155).
    var ticket: String?

    init(ts: Date, type: EventType, reason: String? = nil,
         app: String? = nil, repo: String? = nil,
         branch: String? = nil, ticket: String? = nil) {
        self.ts = ts
        self.type = type
        self.reason = reason
        self.app = app
        self.repo = repo
        self.branch = branch
        self.ticket = ticket
    }
}

final class EventStore {
    private let eventsDir: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let queue = DispatchQueue(label: "worktracker.eventstore")

    init(eventsDir: URL) {
        self.eventsDir = eventsDir
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        try? FileManager.default.createDirectory(at: eventsDir, withIntermediateDirectories: true)
    }

    private func fileURL(for date: Date) -> URL {
        eventsDir.appendingPathComponent("\(Self.dayKey(date)).jsonl")
    }

    static func dayKey(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    /// Haengt ein Event an die Tagesdatei an (thread-safe, atomar pro Zeile).
    func append(_ event: Event) {
        queue.sync {
            guard let line = try? encoder.encode(event),
                  let nl = "\n".data(using: .utf8) else { return }
            let url = fileURL(for: event.ts)
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(line)
                handle.write(nl)
                try? handle.close()
            } else {
                var data = line
                data.append(nl)
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    /// Liest alle Events eines Tages (sortiert nach Zeit).
    func load(date: Date) -> [Event] {
        let url = fileURL(for: date)
        guard let content = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var events: [Event] = []
        for line in content.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let ev = try? decoder.decode(Event.self, from: data) else { continue }
            events.append(ev)
        }
        return events.sorted { $0.ts < $1.ts }
    }
}
