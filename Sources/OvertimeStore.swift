//
//  OvertimeStore.swift
//  WorkTracker
//
//  Überstunden-Konto: Soll/Ist je Tag, Tag-Typen (Urlaub/Feiertag/Krank/
//  Freizeitausgleich) und kumulierter Saldo. Overrides liegen in overtime.json.
//

import Foundation

enum DayType: String, Codable, CaseIterable, Identifiable {
    case work        // normaler Tag (Soll = Ziel an Arbeitstagen)
    case vacation    // Urlaub
    case holiday     // Feiertag
    case sick        // Krank
    case compOff     // Freizeitausgleich (zieht Überstunden ab)

    var id: String { rawValue }
    var label: String {
        switch self {
        case .work:     return "Arbeitstag"
        case .vacation: return "Urlaub"
        case .holiday:  return "Feiertag"
        case .sick:     return "Krank"
        case .compOff:  return "Freizeitausgleich"
        }
    }
}

struct DayOverride: Codable {
    var type: DayType
    /// Bei Freizeitausgleich: abgezogene Stunden (nil = voller Soll-Tag).
    var hours: Double?
}

final class OvertimeStore: ObservableObject {
    @Published var overrides: [String: DayOverride] = [:]
    private let url: URL

    init(dir: URL) {
        url = dir.appendingPathComponent("overtime.json")
        load()
    }

    private func load() {
        guard let data = try? Data(contentsOf: url),
              let dict = try? JSONDecoder().decode([String: DayOverride].self, from: data) else { return }
        overrides = dict
    }

    func save() {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(overrides) {
            try? data.write(to: url, options: .atomic)
        }
    }

    func type(for date: Date) -> DayType { overrides[EventStore.dayKey(date)]?.type ?? .work }
    func override(for date: Date) -> DayOverride? { overrides[EventStore.dayKey(date)] }

    func set(_ date: Date, type: DayType, hours: Double?) {
        let key = EventStore.dayKey(date)
        if type == .work {
            overrides.removeValue(forKey: key)
        } else {
            overrides[key] = DayOverride(type: type, hours: hours)
        }
        save()
    }
}

struct OvertimeRow: Identifiable {
    var id: String
    var date: Date
    var type: DayType
    var target: Double     // Soll-Stunden
    var worked: Double      // Ist-Stunden
    var consumed: Double    // durch Freizeitausgleich abgezogen
    var balance: Double { worked - target - consumed }
}

enum Overtime {
    static func isWorkday(_ date: Date, _ config: AppConfig) -> Bool {
        let wd = Calendar(identifier: .gregorian).component(.weekday, from: date)
        return config.workdayWeekdays.contains(wd)
    }

    /// Tageszeilen von `from` bis `to` (inklusive).
    static func rows(dayStore: DayStore, config: AppConfig, store: OvertimeStore,
                     from: Date, to: Date) -> [OvertimeRow] {
        let cal = Calendar(identifier: .gregorian)
        var rows: [OvertimeRow] = []
        var d = cal.startOfDay(for: from)
        let end = cal.startOfDay(for: to)
        while d <= end {
            let key = EventStore.dayKey(d)
            let type = store.type(for: d)
            let worked = dayStore.summary(date: d).workedSeconds / 3600
            var target = 0.0, consumed = 0.0
            switch type {
            case .work:
                target = isWorkday(d, config) ? config.targetHoursPerDay : 0
            case .vacation, .holiday, .sick:
                target = 0
            case .compOff:
                consumed = store.overrides[key]?.hours ?? config.targetHoursPerDay
            }
            rows.append(OvertimeRow(id: key, date: d, type: type,
                                    target: target, worked: worked, consumed: consumed))
            d = cal.date(byAdding: .day, value: 1, to: d)!
        }
        return rows
    }

    static func total(_ rows: [OvertimeRow], startBalance: Double) -> Double {
        startBalance + rows.reduce(0) { $0 + $1.balance }
    }
}
