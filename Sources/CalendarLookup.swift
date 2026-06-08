//
//  CalendarLookup.swift
//  WorkTracker
//
//  Liest den Titel des gerade laufenden Kalender-Termins (EventKit) – damit ein
//  erkannter Call einen sprechenden Namen bekommt (z. B. „Sprint Review"), da
//  Teams/Zoom keinen lokalen Meeting-Titel bereitstellen.
//

import Foundation
import EventKit

final class CalendarLookup {
    static let shared = CalendarLookup()
    private let store = EKEventStore()
    private var didRequest = false

    /// Einmalig Kalender-Zugriff anfragen.
    private func requestAccessOnce() {
        guard !didRequest else { return }
        didRequest = true
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { _, _ in }
        } else {
            store.requestAccess(to: .event) { _, _ in }
        }
    }

    /// Titel eines Termins, der gerade läuft (nicht ganztägig). nil ohne Zugriff
    /// oder ohne passenden Termin. Fragt den Zugriff bei Bedarf einmal an –
    /// also erst, wenn wirklich ein Call läuft, nicht schon beim App-Start.
    func currentEventTitle(now: Date = Date()) -> String? {
        let status = EKEventStore.authorizationStatus(for: .event)
        if status == .notDetermined { requestAccessOnce(); return nil }
        let ok: Bool
        if #available(macOS 14.0, *) { ok = (status == .fullAccess) }
        else { ok = (status == .authorized) }
        guard ok else { return nil }

        let pred = store.predicateForEvents(withStart: now.addingTimeInterval(-120),
                                            end: now.addingTimeInterval(120), calendars: nil)
        let events = store.events(matching: pred)
        let match = events.first {
            !$0.isAllDay && $0.startDate <= now && $0.endDate >= now && !($0.title ?? "").isEmpty
        }
        return match?.title
    }
}
