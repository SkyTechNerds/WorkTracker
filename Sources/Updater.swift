//
//  Updater.swift
//  WorkTracker
//
//  Prüft GitHub-Releases auf eine neuere Version, lädt das ZIP, ersetzt die
//  laufende App und startet neu. Funktioniert ohne Token nur bei PUBLIC-Repo
//  (oder eigener öffentlicher Feed-URL).
//

import Foundation
import AppKit

struct ReleaseInfo {
    let version: String
    let zipURL: URL
    let notes: String?
}

@MainActor
final class Updater: ObservableObject {
    static let shared = Updater()

    @Published var available: ReleaseInfo?
    @Published var checking = false
    @Published var installing = false
    @Published var statusMessage: String?

    private let repo = "SkyTechNerds/WorkTracker"

    var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    // MARK: - Prüfen

    /// `beta=true` bezieht auch Vorab-Releases (Prereleases) ein.
    func check(silent: Bool = true, beta: Bool = false) async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        do {
            // Stable: /releases/latest (ignoriert Prereleases). Beta: alle Releases.
            let urlStr = beta
                ? "https://api.github.com/repos/\(repo)/releases?per_page=10"
                : "https://api.github.com/repos/\(repo)/releases/latest"
            var req = URLRequest(url: URL(string: urlStr)!)
            req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            req.timeoutInterval = 20
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                if !silent { statusMessage = "Update-Prüfung fehlgeschlagen (Repo public?)." }
                return
            }
            // Release-Objekt bestimmen (Beta: neuestes aus der Liste).
            let release: [String: Any]?
            if beta {
                release = (try JSONSerialization.jsonObject(with: data) as? [[String: Any]])?.first
            } else {
                release = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            }
            guard let rel = release, let tag = rel["tag_name"] as? String else {
                if !silent { statusMessage = "Kein Release gefunden." }
                return
            }
            let version = numericVersion(tag)
            let assets = rel["assets"] as? [[String: Any]] ?? []
            let zip = assets.first { ($0["name"] as? String)?.lowercased().hasSuffix(".zip") == true }
            guard let dl = zip?["browser_download_url"] as? String, let url = URL(string: dl) else {
                if !silent { statusMessage = "Kein ZIP im Release gefunden." }
                return
            }
            let label = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            if isNewer(version, than: currentVersion) {
                available = ReleaseInfo(version: label, zipURL: url, notes: rel["body"] as? String)
                if !silent { statusMessage = "Update verfügbar: v\(label)" }
            } else {
                available = nil
                if !silent { statusMessage = "Du bist aktuell (v\(currentVersion))." }
            }
        } catch {
            if !silent { statusMessage = "Update-Prüfung fehlgeschlagen: \(error.localizedDescription)" }
        }
    }

    /// "v0.2.0-beta1" -> "0.2.0" für den Versionsvergleich.
    private func numericVersion(_ s: String) -> String {
        var v = s.hasPrefix("v") ? String(s.dropFirst()) : s
        if let dash = v.firstIndex(of: "-") { v = String(v[..<dash]) }
        return v
    }

    private func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    // MARK: - Installieren

    func installUpdate() async {
        guard let info = available, !installing else { return }
        installing = true
        defer { installing = false }
        do {
            statusMessage = "Lade v\(info.version)…"
            let (tmpFile, _) = try await URLSession.shared.download(from: info.zipURL)

            let work = FileManager.default.temporaryDirectory
                .appendingPathComponent("wt-update-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            let zip = work.appendingPathComponent("WorkTracker.zip")
            try FileManager.default.moveItem(at: tmpFile, to: zip)

            // Entpacken
            try shell("/usr/bin/ditto", ["-x", "-k", zip.path, work.path])
            let newApp = work.appendingPathComponent("WorkTracker.app")
            guard FileManager.default.fileExists(atPath: newApp.path) else {
                statusMessage = "Update-Paket ungültig."
                return
            }

            let dest = Bundle.main.bundleURL.path
            let pid = ProcessInfo.processInfo.processIdentifier
            // Helper-Skript: wartet bis App beendet, ersetzt Bundle, startet neu.
            let scriptURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("wt-update-\(UUID().uuidString).sh")
            let script = """
            #!/bin/bash
            while kill -0 \(pid) 2>/dev/null; do sleep 0.3; done
            rm -rf "\(dest)"
            cp -R "\(newApp.path)" "\(dest)"
            xattr -cr "\(dest)" 2>/dev/null
            rm -rf "\(work.path)"
            open "\(dest)"
            rm -f "\(scriptURL.path)"
            """
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)

            // Detached starten, dann App beenden.
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-c", "nohup bash '\(scriptURL.path)' >/dev/null 2>&1 &"]
            try p.run()

            statusMessage = "Installiere v\(info.version) – App startet neu…"
            try await Task.sleep(nanoseconds: 400_000_000)
            NSApp.terminate(nil)
        } catch {
            statusMessage = "Update fehlgeschlagen: \(error.localizedDescription)"
        }
    }

    @discardableResult
    private func shell(_ path: String, _ args: [String]) throws -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        return p.terminationStatus
    }
}
