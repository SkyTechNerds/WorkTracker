//
//  CallDetector.swift
//  WorkTracker
//
//  Erkennt laufende Calls (Teams/Zoom/Meet/Slack/…) über aktives Mikrofon
//  (CoreAudio) UND eine laufende Call-App. Kein Mitschneiden – nur Geräte-
//  Status abfragen, daher keine Mikrofon-Freigabe nötig.
//

import Foundation
import CoreAudio
import AppKit

enum CallDetector {
    /// Native Call-Apps: Bundle-ID-Fragment -> Anzeigename.
    static let callApps: [(idFragment: String, name: String)] = [
        ("com.microsoft.teams", "Teams"),
        ("us.zoom.xos", "Zoom"),
        ("com.tinyspeck.slackmacgap", "Slack"),
        ("com.cisco.webexmeetingsapp", "Webex"),
        ("cisco-systems.spark", "Webex"),
        ("com.hnc.discord", "Discord"),
        ("com.apple.facetime", "FaceTime"),
    ]

    /// true, wenn das Standard-Eingabegerät (Mikro) gerade von einem Prozess
    /// genutzt wird.
    static func micActive() -> Bool {
        var deviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &addr, 0, nil, &size, &deviceID) == noErr,
              deviceID != 0 else { return false }

        var running = UInt32(0)
        size = UInt32(MemoryLayout<UInt32>.size)
        addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let st = AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &running)
        return st == noErr && running != 0
    }

    /// Name einer laufenden bekannten Call-App, sonst nil.
    static func runningCallApp() -> String? {
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier?.lowercased() else { continue }
            if let match = callApps.first(where: { bid.contains($0.idFragment) }) {
                return match.name
            }
        }
        return nil
    }

    /// Liefert den Call-App-Namen, wenn aktuell ein Call läuft (Mikro aktiv UND
    /// eine bekannte Call-App geöffnet), sonst nil.
    static func activeCall() -> String? {
        guard micActive() else { return nil }
        return runningCallApp()
    }
}
