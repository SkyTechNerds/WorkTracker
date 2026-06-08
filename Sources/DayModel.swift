//
//  DayModel.swift
//  WorkTracker
//
//  Leitet aus den Roh-Events die Arbeits-/Pausen-Segmente eines Tages ab und
//  verschmilzt sie mit manuellen Korrekturen. Editier-Modell: sobald ein Tag
//  bearbeitet wird, wird die abgeleitete Segmentliste materialisiert
//  (daily/YYYY-MM-DD.edits.json) und ist ab dann die Quelle fuer Anzeige &
//  Bericht. "Auf Auto zuruecksetzen" loescht die Override-Datei wieder.
//

import Foundation

enum SegmentKind: String, Codable, Hashable {
    case work
    case breakTime
}

enum SegmentSource: String, Codable, Hashable {
    case auto
    case manual
}

struct Segment: Codable, Identifiable, Hashable {
    var id: UUID = UUID()
    var start: Date
    var end: Date
    var kind: SegmentKind
    var ticket: String?
    var note: String?
    var source: SegmentSource = .auto

    var duration: TimeInterval { max(0, end.timeIntervalSince(start)) }
}

struct DaySummary {
    var date: Date
    var start: Date?
    var end: Date?
    var workedSeconds: TimeInterval
    var breakSeconds: TimeInterval
    var segments: [Segment]
    /// true, wenn manuelle Overrides existieren (Tag "eingefroren").
    var materialized: Bool
}

final class DayStore {
    private let eventStore: EventStore
    private let dailyDir: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    /// Karenz, bis zu der ein offenes (nicht sauber geschlossenes) Intervall
    /// ueber das letzte Event hinaus verlaengert wird – schuetzt vor
    /// Hochzaehlen bis Mitternacht nach Absturz/Hard-Quit.
    private let graceSeconds: TimeInterval

    init(eventStore: EventStore, dailyDir: URL, graceSeconds: TimeInterval = 180) {
        self.eventStore = eventStore
        self.dailyDir = dailyDir
        self.graceSeconds = graceSeconds
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        try? FileManager.default.createDirectory(at: dailyDir, withIntermediateDirectories: true)
    }

    private func editsURL(_ date: Date) -> URL {
        dailyDir.appendingPathComponent("\(EventStore.dayKey(date)).edits.json")
    }

    func isMaterialized(_ date: Date) -> Bool {
        FileManager.default.fileExists(atPath: editsURL(date).path)
    }

    // MARK: - Ableitung aus Events

    /// Baut aus den Roh-Events Arbeits- und Pausensegmente.
    func deriveSegments(date: Date, now: Date = Date()) -> [Segment] {
        let events = eventStore.load(date: date)
        guard !events.isEmpty else { return [] }

        // Arbeitszeit wird ausschliesslich durch die kanonischen Zustands-Events
        // der State-Machine bestimmt: .active (nach Bestaetigung/Auto) bis
        // .inactive. Lock/Unlock/Sleep/Wake/AppStart sind nur Eingangssignale
        // und markieren KEINE Arbeitszeit (sonst zaehlt App-Start oder ein
        // Unlock trotz "Pause/privat" faelschlich als Arbeit).
        func isActiveStart(_ t: EventType) -> Bool { t == .active }
        func isActiveEnd(_ t: EventType) -> Bool { t == .inactive || t == .appStop }

        // Obergrenze fuer ein offenes Intervall: jetzt, aber hoechstens bis zum
        // letzten Event + Karenz (Crash-Schutz) und nie ueber den Tag hinaus.
        let cal = Calendar(identifier: .gregorian)
        let endOfDay = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: date))!
        let lastTs = events.last?.ts ?? now
        let liveCap = min(now, endOfDay, lastTs.addingTimeInterval(graceSeconds))

        var workIntervals: [(Date, Date)] = []
        var activeSince: Date?
        for ev in events {
            if isActiveStart(ev.type) {
                if activeSince == nil { activeSince = ev.ts }
            } else if isActiveEnd(ev.type) {
                if let s = activeSince {
                    if ev.ts > s { workIntervals.append((s, ev.ts)) }
                    activeSince = nil
                }
            }
        }
        if let s = activeSince, liveCap > s {
            workIntervals.append((s, liveCap))
        }
        guard !workIntervals.isEmpty else { return [] }

        // Ein Arbeitsintervall wird nach Call-Status aufgeteilt: Phasen mit
        // laufendem Call werden als "Meeting" gelabelt (Notiz = App), die
        // restlichen Phasen bekommen das häufigste Ticket der Samples.
        func workSegments(_ start: Date, _ end: Date) -> [Segment] {
            let inRange = events.filter { $0.type == .sample && $0.ts >= start && $0.ts <= end }
                .sorted { $0.ts < $1.ts }
            func ticketFor(_ a: Date, _ b: Date) -> String? {
                var counts: [String: Int] = [:]
                for ev in inRange where ev.ts >= a && ev.ts <= b && ev.call == nil {
                    if let t = ev.ticket { counts[t, default: 0] += 1 }
                }
                return counts.max(by: { $0.value < $1.value })?.key
            }
            func makeSeg(_ a: Date, _ b: Date, call: String?) -> Segment {
                if let call {
                    // call ist Kalender-Titel oder generisch "Meeting".
                    let note = call == "Meeting" ? nil : call
                    return Segment(start: a, end: b, kind: .work, ticket: "Meeting",
                                   note: note, source: .auto)
                }
                return Segment(start: a, end: b, kind: .work, ticket: ticketFor(a, b),
                               note: nil, source: .auto)
            }
            guard !inRange.isEmpty else { return [makeSeg(start, end, call: nil)] }

            var subs: [Segment] = []
            var segStart = start
            var state: String? = inRange.first?.call
            for ev in inRange {
                if ev.call != state {
                    if ev.ts > segStart { subs.append(makeSeg(segStart, ev.ts, call: state)) }
                    segStart = ev.ts
                    state = ev.call
                }
            }
            if end > segStart { subs.append(makeSeg(segStart, end, call: state)) }
            return subs
        }

        var segments: [Segment] = []
        for (i, iv) in workIntervals.enumerated() {
            segments.append(contentsOf: workSegments(iv.0, iv.1))
            // Pause = Luecke bis zum naechsten Arbeitsintervall.
            if i + 1 < workIntervals.count {
                let gapStart = iv.1
                let gapEnd = workIntervals[i + 1].0
                if gapEnd > gapStart {
                    segments.append(Segment(start: gapStart, end: gapEnd, kind: .breakTime,
                                            ticket: nil, note: nil, source: .auto))
                }
            }
        }

        // Laufende Pause am Tagesende fuer HEUTE sichtbar machen: wenn der
        // letzte Zustand inaktiv ist (manuelle Pause / Sperre / idle) und nach
        // dem letzten Arbeitsblock liegt, eine offene Pause bis jetzt anzeigen.
        // activeSince == nil => aktuell KEIN offenes Arbeitsintervall => Pause.
        if Calendar.current.isDateInToday(date),
           activeSince == nil,
           let lastWorkEnd = workIntervals.last?.1,
           let lastState = events.last(where: { $0.type == .active || $0.type == .inactive }),
           lastState.type == .inactive,
           lastState.reason != "feierabend", lastState.reason != "quit" {
            let capNow = min(now, endOfDay)
            if capNow > lastWorkEnd {
                segments.append(Segment(start: lastWorkEnd, end: capNow, kind: .breakTime,
                                        ticket: nil, note: nil, source: .auto))
            }
        }
        return segments
    }

    // MARK: - Laden / Speichern (Auto + Overrides)

    /// Liefert die anzuzeigenden Segmente.
    /// - Vergangene Tage: materialisierter Snapshot (eingefroren, voll editierbar).
    /// - HEUTE materialisiert: eingefrorene Korrekturen bis zum letzten Edit-Punkt
    ///   PLUS Live-Fortsetzung danach – so läuft das Tracking nach einem Edit
    ///   einfach weiter (z. B. Vormittag korrigiert, Nachmittag live).
    /// - Sonst: reine Live-Ableitung. "Auf Auto" entfernt die Korrekturen.
    func segments(date: Date, now: Date = Date()) -> [Segment] {
        if isMaterialized(date), let data = try? Data(contentsOf: editsURL(date)),
           let stored = try? decoder.decode([Segment].self, from: data) {
            guard Calendar.current.isDateInToday(date) else {
                return stored.sorted { $0.start < $1.start }
            }
            // Heute: hinter dem letzten korrigierten Zeitpunkt live weiterlaufen.
            let cutoff = stored.map(\.end).max() ?? Calendar.current.startOfDay(for: date)
            var tail: [Segment] = []
            for var s in deriveSegments(date: date, now: now) where s.end > cutoff {
                if s.start < cutoff { s.start = cutoff }
                tail.append(s)
            }
            // Fortsetzung desselben Blocks (z. B. laufendes Meeting) an den
            // bearbeiteten Block anhängen statt einen neuen zu erzeugen.
            return coalesce((stored + tail).sorted { $0.start < $1.start })
        }
        return coalesce(deriveSegments(date: date, now: now))
    }

    /// Identität eines Segments fürs Verschmelzen: gleiche Notiz (z. B.
    /// Kalender-Titel des Meetings) oder gleiches Ticket.
    private func identity(_ s: Segment) -> String {
        if let n = s.note, !n.isEmpty { return "N|" + n }
        return "T|" + (s.ticket ?? "")
    }

    /// Verschmilzt zeitlich zusammenhängende Arbeitsblöcke gleicher Identität –
    /// behält die Felder des früheren (ggf. manuell bearbeiteten) Blocks.
    private func coalesce(_ segs: [Segment]) -> [Segment] {
        let sorted = segs.sorted { $0.start < $1.start }
        var out: [Segment] = []
        for s in sorted {
            if var last = out.last, last.kind == .work, s.kind == .work,
               identity(last) == identity(s), s.start <= last.end.addingTimeInterval(1) {
                last.end = max(last.end, s.end)
                out[out.count - 1] = last
            } else {
                out.append(s)
            }
        }
        return out
    }

    /// Speichert eine bearbeitete Segmentliste (materialisiert den Tag).
    func save(date: Date, segments: [Segment]) {
        let sorted = segments.sorted { $0.start < $1.start }
        if let data = try? encoder.encode(sorted) {
            try? data.write(to: editsURL(date), options: .atomic)
        }
    }

    /// Verwirft manuelle Korrekturen und kehrt zur Auto-Ableitung zurueck.
    func resetToAuto(date: Date) {
        try? FileManager.default.removeItem(at: editsURL(date))
    }

    // MARK: - Zeit je Ticket

    /// Summe der Arbeitszeit je Ticket fuer einen Tag (absteigend sortiert).
    func ticketTotals(date: Date, now: Date = Date()) -> [(ticket: String, seconds: TimeInterval)] {
        let work = segments(date: date, now: now).filter { $0.kind == .work }
        var map: [String: TimeInterval] = [:]
        for s in work {
            map[s.ticket ?? "Ohne Ticket", default: 0] += s.duration
        }
        return map.sorted { $0.value > $1.value }.map { (ticket: $0.key, seconds: $0.value) }
    }

    /// Summe je Ticket ueber eine Woche (7 Tage ab weekStart).
    func weekTicketTotals(weekStart: Date, cal: Calendar, now: Date = Date()) -> [(ticket: String, seconds: TimeInterval)] {
        var map: [String: TimeInterval] = [:]
        for i in 0..<7 {
            guard let d = cal.date(byAdding: .day, value: i, to: weekStart) else { continue }
            for t in ticketTotals(date: d, now: now) { map[t.ticket, default: 0] += t.seconds }
        }
        return map.sorted { $0.value > $1.value }.map { (ticket: $0.key, seconds: $0.value) }
    }

    // MARK: - Zusammenfassung

    func summary(date: Date, now: Date = Date()) -> DaySummary {
        let segs = segments(date: date, now: now)
        let work = segs.filter { $0.kind == .work }
        let breaks = segs.filter { $0.kind == .breakTime }
        let workedSeconds = work.reduce(0) { $0 + $1.duration }
        let breakSeconds = breaks.reduce(0) { $0 + $1.duration }
        return DaySummary(
            date: date,
            start: segs.map(\.start).min(),
            end: segs.map(\.end).max(),
            workedSeconds: workedSeconds,
            breakSeconds: breakSeconds,
            segments: segs,
            materialized: isMaterialized(date))
    }
}
