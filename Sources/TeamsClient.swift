//
//  TeamsClient.swift
//  WorkTracker
//
//  Lokale Microsoft-Teams-Drittanbieter-API (WebSocket auf 127.0.0.1:8124) –
//  dieselbe, die Hardware-Mute-Tasten nutzen. Liefert zuverlässig den
//  Meeting-Status (isInMeeting/Muted/…) ohne Mikrofon-Heuristik. Beim ersten
//  Verbinden zeigt Teams einen Kopplungs-Dialog; der zurückgelieferte Token
//  wird gespeichert (kein erneutes Pairing nötig).
//
//  Voraussetzung: In Teams die Drittanbieter-API erlauben.
//

import Foundation
import AppKit

@MainActor
final class TeamsClient: ObservableObject {
    static let shared = TeamsClient()

    @Published var isInMeeting = false
    @Published var connected = false
    @Published var status: String = "inaktiv"

    /// Wird bei jeder Änderung von isInMeeting sofort aufgerufen.
    var onMeetingChange: (() -> Void)?

    private var task: URLSessionWebSocketTask?
    private var enabled = false
    private var reconnectWork: DispatchWorkItem?

    private var token: String {
        get { UserDefaults.standard.string(forKey: "teamsApiToken") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "teamsApiToken") }
    }

    // MARK: - Steuerung

    func start() {
        guard !enabled else { return }
        enabled = true
        connect()
    }

    func stop() {
        enabled = false
        reconnectWork?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
        isInMeeting = false
        status = "inaktiv"
    }

    // MARK: - Verbindung

    private func connect() {
        guard enabled else { return }
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        var comps = URLComponents()
        comps.scheme = "ws"
        comps.host = "127.0.0.1"
        comps.port = 8124
        comps.path = "/"
        comps.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "protocol-version", value: "2.0.0"),
            URLQueryItem(name: "manufacturer", value: "WorkTracker"),
            URLQueryItem(name: "device", value: "Mac"),
            URLQueryItem(name: "app", value: "WorkTracker"),
            URLQueryItem(name: "app-version", value: appVersion),
        ]
        guard let url = comps.url else { return }

        status = token.isEmpty ? "warte auf Teams-Kopplung…" : "verbinde…"
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    self.connected = true
                    switch message {
                    case .string(let s): self.handle(s)
                    case .data(let d): if let s = String(data: d, encoding: .utf8) { self.handle(s) }
                    @unknown default: break
                    }
                    self.receive()
                case .failure:
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handle(_ s: String) {
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        if let tok = obj["tokenRefresh"] as? String, !tok.isEmpty {
            token = tok
            status = "gekoppelt"
        }
        if let mu = obj["meetingUpdate"] as? [String: Any] {
            let prev = isInMeeting
            if let ms = mu["meetingState"] as? [String: Any], let inM = ms["isInMeeting"] as? Bool {
                isInMeeting = inM
            } else if let mp = mu["meetingPermissions"] as? [String: Any] {
                // Neues Teams sendet ausserhalb eines Meetings nur Permissions.
                // canLeave (bzw. canToggleMute) ist nur im Meeting true.
                let canLeave = (mp["canLeave"] as? Bool) ?? false
                let canMute = (mp["canToggleMute"] as? Bool) ?? false
                isInMeeting = canLeave || canMute
            }
            status = isInMeeting ? "im Meeting" : "verbunden"
            if isInMeeting != prev { onMeetingChange?() }
        }
        if let err = obj["errorMsg"] as? String {
            status = "Teams: \(err)"
        }
    }

    private func scheduleReconnect() {
        connected = false
        isInMeeting = false
        task = nil
        guard enabled else { return }
        status = "Teams nicht erreichbar – neuer Versuch…"
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in self?.connect() }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
    }
}
