//
//  Notifier.swift
//  WorkTracker
//
//  Duenne Huelle um lokale Mitteilungen (UserNotifications), u. a. fuer die
//  Info "neues Ticket erkannt".
//

import Foundation
import UserNotifications

@MainActor
enum Notifier {
    /// Fragt einmalig die Berechtigung fuer Mitteilungen an.
    static func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Zeigt eine einfache Banner-Mitteilung.
    static func post(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(req, withCompletionHandler: nil)
    }
}
