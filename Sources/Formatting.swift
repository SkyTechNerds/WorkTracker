//
//  Formatting.swift
//  WorkTracker
//
//  Gemeinsame Formatierungs-Helfer fuer UI und Bericht.
//

import Foundation

enum Fmt {
    /// "6h 12m" aus Sekunden.
    static func hm(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let h = total / 3600
        let m = (total % 3600) / 60
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    /// Rundet Sekunden auf das naechste Vielfache von `m` Minuten (0 = exakt).
    static func roundedSeconds(_ s: TimeInterval, toMinutes m: Int) -> TimeInterval {
        guard m > 0 else { return s }
        let step = Double(m) * 60
        return (s / step).rounded() * step
    }

    /// "6h 12m" aus Sekunden, gerundet auf `m` Minuten.
    static func hm(_ seconds: TimeInterval, roundTo m: Int) -> String {
        hm(roundedSeconds(seconds, toMinutes: m))
    }

    /// "+6h 12m" / "−3h 05m" aus Stunden (für Salden).
    static func signedHM(hours: Double) -> String {
        let sign = hours < 0 ? "−" : "+"
        let total = Int((abs(hours) * 3600).rounded())
        let h = total / 3600, m = (total % 3600) / 60
        return h > 0 ? "\(sign)\(h)h \(String(format: "%02d", m))m" : "\(sign)\(m)m"
    }

    /// "6,0h" Stunden mit einer Nachkommastelle.
    static func hours1(_ hours: Double) -> String {
        String(format: "%.1fh", hours).replacingOccurrences(of: ".", with: ",")
    }

    /// "08:42" lokale Uhrzeit.
    static func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    /// "Mo 08.06." – deutsche Kurzform (fuer schmale Spalten).
    static func weekdayShort(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "EE dd.MM."
        return f.string(from: date)
    }

    /// "Montag 08.06." – ausgeschriebener deutscher Wochentag.
    static func weekdayLong(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "EEEE dd.MM."
        return f.string(from: date)
    }

    /// ISO-Tagesschluessel "yyyy-MM-dd".
    static func dayKey(_ date: Date) -> String { EventStore.dayKey(date) }
}
