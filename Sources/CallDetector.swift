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

    // MARK: - Mikrofon

    /// true, wenn IRGENDEIN Eingabegerät gerade von einem Prozess genutzt wird.
    static func micActive() -> Bool {
        for device in inputDevices() where deviceIsRunning(device) {
            return true
        }
        return false
    }

    private static func deviceIsRunning(_ device: AudioDeviceID) -> Bool {
        var running = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let st = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &running)
        return st == noErr && running != 0
    }

    /// Alle Audiogeräte mit Eingangskanälen (Mikrofone).
    private static func inputDevices() -> [AudioDeviceID] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                             &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        let count = Int(size) / MemoryLayout<AudioDeviceID>.size
        var devices = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &addr, 0, nil, &size, &devices) == noErr else { return [] }
        return devices.filter { hasInputChannels($0) }
    }

    private static func hasInputChannels(_ device: AudioDeviceID) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return false }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size),
                                                   alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return false }
        let abl = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        var channels = 0
        for buf in abl { channels += Int(buf.mNumberChannels) }
        return channels > 0
    }

    // MARK: - Call-App

    /// Name einer laufenden bekannten Call-App – bevorzugt die Vordergrund-App.
    static func runningCallApp() -> String? {
        if let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased(),
           let m = callApps.first(where: { front.contains($0.idFragment) }) {
            return m.name
        }
        for app in NSWorkspace.shared.runningApplications {
            guard let bid = app.bundleIdentifier?.lowercased() else { continue }
            if let m = callApps.first(where: { bid.contains($0.idFragment) }) {
                return m.name
            }
        }
        return nil
    }

    /// Call-App-Name, wenn aktuell ein Call läuft (Mikro aktiv UND Call-App), sonst nil.
    static func activeCall() -> String? {
        guard micActive() else { return nil }
        return runningCallApp()
    }
}
