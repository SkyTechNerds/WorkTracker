//
//  GitProbe.swift
//  WorkTracker
//
//  Duenne Huelle um die Git-CLI: aktueller Branch, heutige Commits (gefiltert
//  auf die zugeordnete Identitaet) und Entdeckung der im System vorhandenen
//  Git-User (fuer das Settings-Dropdown).
//

import Foundation

struct CommitInfo: Identifiable, Hashable {
    var id: String { hash }
    var hash: String
    var subject: String
    var date: Date
    var authorEmail: String
}

enum GitProbe {
    static let gitPath = "/usr/bin/git"

    /// Fuehrt git mit Argumenten in einem Repo aus und liefert stdout.
    @discardableResult
    static func run(_ args: [String], in repoPath: String? = nil) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: gitPath)
        var fullArgs = args
        if let repoPath { fullArgs = ["-C", repoPath] + args }
        proc.arguments = fullArgs
        // Stabiler, locale-unabhaengiger Output:
        proc.environment = ["GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "HOME": NSHomeDirectory()]
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        do {
            try proc.run()
            let data = outPipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            return String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            return ""
        }
    }

    /// Aktueller Branch eines Repos ("" wenn detached/kein Repo).
    static func currentBranch(_ repoPath: String) -> String? {
        let b = run(["rev-parse", "--abbrev-ref", "HEAD"], in: repoPath)
        if b.isEmpty || b == "HEAD" { return nil }
        return b
    }

    /// Zeitpunkt der letzten Aenderung im Working Tree (heuristisch ueber
    /// Index-/HEAD-Mtime) – dient als "welches Repo ist gerade aktiv".
    static func lastActivity(_ repoPath: String) -> Date? {
        let candidates = [".git/index", ".git/ORIG_HEAD", ".git/HEAD"]
        var latest: Date?
        for c in candidates {
            let p = (repoPath as NSString).appendingPathComponent(c)
            if let attrs = try? FileManager.default.attributesOfItem(atPath: p),
               let m = attrs[.modificationDate] as? Date {
                if latest == nil || m > latest! { latest = m }
            }
        }
        return latest
    }

    /// Parst ein Ticket-Kuerzel aus dem Branchnamen, z. B. "wcms-2155-b2b" -> "WCMS-2155".
    static func ticket(fromBranch branch: String?) -> String? {
        guard let branch else { return nil }
        guard let re = try? NSRegularExpression(pattern: "([A-Za-z]{2,})-([0-9]+)") else { return nil }
        let range = NSRange(branch.startIndex..., in: branch)
        guard let m = re.firstMatch(in: branch, range: range),
              let kr = Range(m.range(at: 1), in: branch),
              let nr = Range(m.range(at: 2), in: branch) else { return nil }
        return "\(branch[kr].uppercased())-\(branch[nr])"
    }

    /// Heutige Commits eines Repos, gefiltert auf die zugeordnete E-Mail.
    static func commitsToday(repoPath: String, authorEmail: String) -> [CommitInfo] {
        let raw = run([
            "log", "--since=midnight", "--no-merges",
            "--pretty=format:%H%x1f%s%x1f%cI%x1f%ae%x1e"
        ], in: repoPath)
        return parseCommits(raw, authorEmail: authorEmail)
    }

    /// Commits eines Repos in einem Zeitfenster (fuer beliebige Tage).
    static func commitsBetween(repoPath: String, since: Date, until: Date, authorEmail: String) -> [CommitInfo] {
        let iso = ISO8601DateFormatter()
        let raw = run([
            "log", "--since=\(iso.string(from: since))", "--until=\(iso.string(from: until))",
            "--no-merges", "--pretty=format:%H%x1f%s%x1f%cI%x1f%ae%x1e"
        ], in: repoPath)
        return parseCommits(raw, authorEmail: authorEmail)
    }

    /// Parst die `git log`-Ausgabe (Felder per \x1f, Records per \x1e).
    private static func parseCommits(_ raw: String, authorEmail: String) -> [CommitInfo] {
        guard !raw.isEmpty else { return [] }
        let iso = ISO8601DateFormatter()
        var commits: [CommitInfo] = []
        for record in raw.components(separatedBy: "\u{1e}") {
            let r = record.trimmingCharacters(in: .whitespacesAndNewlines)
            if r.isEmpty { continue }
            let f = r.components(separatedBy: "\u{1f}")
            if f.count < 4 { continue }
            let email = f[3].lowercased()
            if !authorEmail.isEmpty && email != authorEmail.lowercased() { continue }
            commits.append(CommitInfo(
                hash: String(f[0].prefix(8)),
                subject: f[1],
                date: iso.date(from: f[2]) ?? Date(),
                authorEmail: f[3]))
        }
        return commits
    }

    /// Entdeckt alle im System vorhandenen Git-Identitaeten (E-Mails) fuer das
    /// Settings-Dropdown: globale Config, jedes Repo, und `gh` falls vorhanden.
    static func discoverUsers(repoPaths: [String]) -> [String] {
        var set = Set<String>()

        // 1) globale git config
        let globalEmail = run(["config", "--global", "user.email"])
        if !globalEmail.isEmpty { set.insert(globalEmail) }

        // 2) pro Repo: lokale config + letzte Commit-Autoren
        for path in repoPaths {
            let localEmail = run(["config", "user.email"], in: path)
            if !localEmail.isEmpty { set.insert(localEmail) }
            let authors = run(["log", "-50", "--pretty=format:%ae"], in: path)
            for a in authors.split(separator: "\n") {
                let s = a.trimmingCharacters(in: .whitespaces)
                if !s.isEmpty { set.insert(s) }
            }
        }

        // 3) gh CLI (falls installiert)
        for ghPath in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
            if FileManager.default.isExecutableFile(atPath: ghPath) {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: ghPath)
                proc.arguments = ["api", "user", "--jq", ".email // empty"]
                let pipe = Pipe()
                proc.standardOutput = pipe
                proc.standardError = Pipe()
                if (try? proc.run()) != nil {
                    let d = pipe.fileHandleForReading.readDataToEndOfFile()
                    proc.waitUntilExit()
                    if let e = String(data: d, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines), !e.isEmpty {
                        set.insert(e)
                    }
                }
                break
            }
        }

        return set.sorted()
    }
}
